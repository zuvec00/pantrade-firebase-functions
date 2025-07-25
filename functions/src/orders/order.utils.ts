import * as https from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";

import {admin, db} from "../firebase";
import {calculateServiceCharge} from "../fees/fees.utils";

interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
  price: number;
  selectedOptions?: Array<Record<string, any>>;
  selectedPackaging?: Record<string, any>;
}

interface IncomingOrder {
  orderId: string;
  userId: string;
  vendorId: string;
  vendorCategory: string;

  items: OrderItem[];
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  vendorCommission: number;
  vendorEarnings: number;

  totalAmountPaid: number;

  deliveryType: string;
  deliveryAddress: string;
  orderCutoffTime: string;
  vendorNote?: string; // optional, since it's a new addition

  paymentReference: string;
  paymentStatus: "pending" | "paid" | "failed";
  orderStatus: "pending" | "processing" | "completed" | "cancelled";

  createdAt: string | number;
  updatedAt: string | number;

  // Reward related fields - all optional
  appliedRewardType?: string; // Type of reward applied (e.g., "1000_naira_off")
  rewardDiscountAmount?: number; // Amount discounted due to reward
  originalTotalBeforeReward?: number; // Total before reward was applied
  platformDebtAmount?: number; // Amount platform needs to cover for vendor
  platformDebtType?: "delivery_fee" | "service_charge" | "monetary"; // Type of debt
  platformDebtSettled?: boolean; // Whether platform has settled the debt with vendor
}


export const createOrderAndLogTransaction = https.onCall({enforceAppCheck: true}, async (request) => {
  const order = request.data.order as IncomingOrder;
  const userId = request.data.userId as string;
  const reference = request.data.reference as string;
  const status = request.data.status as "success" | "pending" | "failed";
  const totalPaid = request.data.totalPaid as number;

  if (!order || !order.vendorId || !order.orderId) {
    throw new HttpsError("invalid-argument", "Missing order details.");
  }

  const serverCalculatedServiceFee = calculateServiceCharge(order.subtotal);
  if (Math.abs(serverCalculatedServiceFee - order.serviceFee) > 1) {
    throw new HttpsError("invalid-argument", "Service fee mismatch.");
  }

  // Ensure service fee is consistent
  order.serviceFee = serverCalculatedServiceFee;

  // Utility to get commission rate
  const getCommissionRate = (monthlySales: number): number => {
    if (monthlySales >= 150_000) return 0.03;
    if (monthlySales >= 50_000) return 0.05;
    return 0.07;
  };

  // Get current month key like "2025-05"
  const getCurrentMonthKey = () => {
    const now = new Date();
    return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}`;
  };

  // Calculate expected total considering rewards if present
  let expectedTotal = order.subtotal + order.deliveryFee + order.serviceFee;
  if (order.appliedRewardType && order.originalTotalBeforeReward !== undefined) {
    expectedTotal = order.originalTotalBeforeReward;
  }

  if (Math.abs(totalPaid - expectedTotal) > 1) {
    throw new HttpsError("invalid-argument", "Total paid mismatch.");
  }
  order.totalAmountPaid = totalPaid;

  try {
    const orderRef = db.collection("orders").doc(order.orderId);
    const userRef = db.collection("users").doc(order.vendorId);
    const currentMonthKey = getCurrentMonthKey();

    await db.runTransaction(async (transaction) => {
      const [orderDoc, userDoc] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(userRef),
      ]);

      if (orderDoc.exists) {
        throw new HttpsError("already-exists", "Order already exists.");
      }

      if (!userDoc.exists) {
        throw new HttpsError("not-found", "Vendor not found.");
      }

      const userData = userDoc.data();
      const wallet = userData?.wallet || {};
      const currentBalance = wallet.balance || 0;
      const currentPending = wallet.pendingBalance || 0;

      const currentMonthSales = userData?.stats?.monthlySales?.[currentMonthKey] || 0;
      const totalVendorRevenue = order.subtotal + order.deliveryFee;

      const commissionRate = getCommissionRate(currentMonthSales);
      const flatCommission = 0; // Flat commission can be set here if needed
      const vendorCommission = flatCommission;
      const vendorEarnings = totalVendorRevenue - vendorCommission;
      const newMonthSales = currentMonthSales + totalVendorRevenue;

      order.vendorCommission = vendorCommission;
      order.vendorEarnings = vendorEarnings;

      const newBalance = currentBalance + vendorEarnings;
      const newPendingBalance = currentPending + vendorEarnings;

      const transactionEntry = {
        amount: vendorEarnings,
        totalPaid,
        reference,
        status,
        type: "credit",
        source: "order",
        orderId: order.orderId,
        vendorId: order.vendorId,
        userId,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        serviceFee: order.serviceFee,
        vendorCommission: order.vendorCommission,
        vendorEarnings: order.vendorEarnings, // subtotal - commission + deliveryFee
        commissionRate: commissionRate,
        createdAt: new Date(),
        // Add reward fields to transaction if they exist
        ...(order.appliedRewardType && {
          appliedRewardType: order.appliedRewardType,
          rewardDiscountAmount: order.rewardDiscountAmount,
          originalTotalBeforeReward: order.originalTotalBeforeReward,
          platformDebtAmount: order.platformDebtAmount,
          platformDebtType: order.platformDebtType,
          platformDebtSettled: false, // Always start as false for new orders
        }),
      };

      transaction.set(orderRef, {
        ...order,
        createdAt: admin.firestore.Timestamp.fromDate(new Date(order.createdAt)),
        updatedAt: admin.firestore.Timestamp.fromDate(new Date(order.updatedAt)),
        // Ensure platformDebtSettled is false for new orders with rewards
        ...(order.appliedRewardType && {
          platformDebtSettled: false,
        }),
      });

      transaction.update(userRef, {
        "wallet.balance": newBalance,
        "wallet.pendingBalance": newPendingBalance,
        "wallet.transactions": admin.firestore.FieldValue.arrayUnion(transactionEntry),
        [`stats.monthlySales.${currentMonthKey}`]: newMonthSales,
        "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    console.log("Order created and logged with correct commission logic.");
    return {success: true};
  } catch (error) {
    console.error("Error in transaction:", error);
    throw new HttpsError("internal", "Transaction failed", error);
  }
});

export const generateDeliveryCode = https.onCall({enforceAppCheck: true}, async (request) => {
  const orderId = request.data.orderId as string;

  if (!orderId) {
    throw new HttpsError("invalid-argument", "Missing order ID.");
  }

  const orderRef = db.collection("orders").doc(orderId);

  try {
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }

    const existingData = orderSnap.data();

    // Don't overwrite if already confirmed
    if (existingData?.deliveryConfirmed === true) {
      throw new HttpsError("failed-precondition", "Order already marked as delivered.");
    }

    // Generate 4-digit OTP
    const deliveryCode = Math.floor(1000 + Math.random() * 9000).toString();

    // Set expiration time (24 hours from now)
    const expiration = new Date();
    expiration.setHours(expiration.getHours() + 72);

    await orderRef.update({
      deliveryCode,
      deliveryCodeExpiresAt: admin.firestore.Timestamp.fromDate(expiration),
      deliveryConfirmed: false,
    });

    console.log(`Delivery code ${deliveryCode} generated for order ${orderId}`);
    return {success: true, deliveryCode};
  } catch (error) {
    console.error("Failed to generate delivery code:", error);
    throw new HttpsError("internal", "Failed to generate delivery code.", error);
  }
});

export const confirmOrderWithOTP = https.onCall({enforceAppCheck: true}, async (request) => {
  const {orderId, vendorId, enteredOtp} = request.data;

  if (!orderId || !vendorId || !enteredOtp) {
    throw new HttpsError("invalid-argument", "Missing orderId, vendorId, or OTP.");
  }

  const orderRef = db.collection("orders").doc(orderId);
  const vendorRef = db.collection("users").doc(vendorId);

  try {
    await db.runTransaction(async (transaction) => {
      const [orderDoc, vendorDoc] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(vendorRef),
      ]);

      if (!orderDoc.exists) {
        throw new HttpsError("not-found", "Order not found.");
      }

      if (!vendorDoc.exists) {
        throw new HttpsError("not-found", "Vendor not found.");
      }

      const orderData = orderDoc.data();
      const vendorData = vendorDoc.data();
      const correctOtp = orderData?.deliveryCode;
      const deliveryConfirmed = orderData?.deliveryConfirmed;
      const now = new Date();
      const expiresAt = orderData?.deliveryCodeExpiresAt?.toDate?.();

      if (expiresAt && now > expiresAt) {
        throw new HttpsError("deadline-exceeded", "OTP has expired.");
      }

      if (deliveryConfirmed === true) {
        throw new HttpsError("already-exists", "Delivery already confirmed.");
      }

      if (enteredOtp !== correctOtp) {
        throw new HttpsError("permission-denied", "Incorrect OTP.");
      }

      const pendingBalance = vendorData?.wallet?.pendingBalance ?? 0;
      const eligibleBalance = vendorData?.wallet?.eligibleBalance ?? 0;
      const commission = orderData?.vendorEarnings ?? 0;

      if (commission > pendingBalance) {
        throw new HttpsError("failed-precondition", "Pending balance too low.");
      }

      // Move commission to eligibleBalance
      transaction.update(vendorRef, {
        "wallet.pendingBalance": pendingBalance - commission,
        "wallet.eligibleBalance": eligibleBalance + commission,
        "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
      });
      const watOffsetMs = 60 * 60 * 1000; // 1 hour in milliseconds (UTC+1)
      const localWATDate = new Date(now.getTime() + watOffsetMs);

      // Format as ISO string without 'Z' (force UTC+1)
      const localWATTime = localWATDate.toISOString()
        .replace("Z", "+01:00"); // Replace 'Z' with '+01:00'

      // Update Firestore
      transaction.update(orderRef, {
        deliveryConfirmed: true,
        orderStatus: "completed",
        reviewed: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        timeline: admin.firestore.FieldValue.arrayUnion({
          status: "Order completed",
          timestamp: localWATTime, // Now in format "2025-04-13T23:41:07.884+01:00"
          actor: "vendor",
        }),
      });
    });

    return {success: true, message: "Order confirmed and commission moved."};
  } catch (error) {
    console.error("OTP confirmation failed:", error);
    throw new HttpsError("internal", "OTP confirmation failed", error);
  }
});
