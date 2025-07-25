import * as https from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";
import {admin, db} from "../firebase";
import axios from "axios";
import {getPaystackHeaders, calculateAmount} from "../paystack/paystack.utils";
import {getCurrentMonthKey} from "../helper/helper.utils";


export const requestRefund = https.onCall({enforceAppCheck: true}, async (request) => {
  const {orderId, userId, vendorId, amount, subtotal, deliveryFee, serviceFee, vendorEarnings, totalPaid, reason} = request.data;

  if (
    orderId == null ||
    userId == null ||
    vendorId == null ||
    amount == null ||
    subtotal == null ||
    deliveryFee == null ||
    vendorEarnings == null ||
    totalPaid == null ||
    reason == null
  ) {
    throw new HttpsError("invalid-argument", "Missing required fields.");
  }


  const refundRef = db.collection("refundRequests").doc(orderId);

  try {
    const existing = await refundRef.get();
    if (existing.exists) {
      throw new HttpsError("already-exists", "Refund request already exists.");
    }

    await refundRef.set({
      orderId,
      userId,
      vendorId,
      amount,
      subtotal,
      deliveryFee,
      serviceFee,
      vendorEarnings,
      totalPaid,
      reason,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {success: true, message: "Refund request submitted."};
  } catch (error) {
    console.error("Refund request failed:", error);
    throw new HttpsError("internal", "Refund request failed.");
  }
});

export const rejectRefundRequest = https.onCall({enforceAppCheck: true}, async (request) => {
  const {orderId, reason} = request.data;

  if (!orderId) {
    throw new HttpsError("invalid-argument", "Missing order ID.");
  }

  const refundRef = db.collection("refundRequests").doc(orderId);

  try {
    await db.runTransaction(async (transaction) => {
      const refundDoc = await transaction.get(refundRef);

      if (!refundDoc.exists) {
        throw new HttpsError("not-found", "Refund request not found.");
      }

      const refundData = refundDoc.data();
      if (!refundData || refundData.status !== "pending") {
        throw new HttpsError("failed-precondition", "Only pending refunds can be rejected.");
      }

      transaction.update(refundRef, {
        status: "rejected",
        rejectionReason: reason || "Refund rejected",
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return {success: true, message: "Refund rejected."};
  } catch (error) {
    console.error("Reject refund failed:", error);
    throw new HttpsError("internal", "Reject refund failed.");
  }
});

export const approveRefundRequest = https.onCall(
  {
    secrets: ["PAYSTACK_TEST_SECRET_KEY", "PAYSTACK_LIVE_SECRET_KEY"],
    enforceAppCheck: true,
  },
  async (request) => {
    const {orderId, userId, amount, isLive} = request.data;

    if (!orderId || !userId || !amount) {
      throw new HttpsError("invalid-argument", "Missing refund approval data.");
    }

    const refundRef = db.collection("refundRequests").doc(orderId);
    const userRef = db.collection("users").doc(userId);

    try {
      await db.runTransaction(async (transaction) => {
        const refundDoc = await transaction.get(refundRef);
        if (!refundDoc.exists) throw new HttpsError("not-found", "Refund request not found.");

        const refundData = refundDoc.data();
        if (!refundData || refundData.status !== "pending") {
          throw new HttpsError("failed-precondition", "Refund already processed.");
        }
        const vendorId = refundData.vendorId;

        // Step 1: Get user's bank info
        const userDoc = await transaction.get(userRef);
        const userData = userDoc.data();
        const vendorRef = db.collection("users").doc(vendorId);
        const vendorDoc = await transaction.get(vendorRef);
        const vendorData = vendorDoc.data();
        const bank = userData?.paymentInfo;

        if (!bank?.accountNumber || !bank?.accountName || !bank?.bankCode) {
          throw new HttpsError("failed-precondition", "User bank details missing.");
        }

        const headers = getPaystackHeaders(isLive);
        const recipientPayload = {
          type: "nuban",
          name: bank.accountName,
          account_number: bank.accountNumber,
          bank_code: bank.bankCode,
          currency: "NGN",
        };

        // Step 2: Create recipient
        const recipientRes = await axios.post(
          "https://api.paystack.co/transferrecipient",
          recipientPayload,
          {headers}
        );
        const recipientCode = recipientRes.data.data.recipient_code;

        // Step 3: Transfer refund
        const transferRes = await axios.post(
          "https://api.paystack.co/transfer",
          {
            source: "balance",
            amount: calculateAmount(refundData.amount),
            recipient: recipientCode,
            reason: `Refund for order ${orderId}`,
          },
          {headers}
        );

        // Step 4: Update refund doc and user transactions
        transaction.update(refundRef, {
          status: "approved",
          transferReference: transferRes.data.data.reference,
          approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const transactions = userData?.wallet?.transactions || [];
        transaction.update(userRef, {
          "wallet.transactions": [
            ...transactions,
            {
              type: "credit",
              status: "success",
              source: "refund",
              amount,
              reference: transferRes.data.data.reference,
              userId,
              createdAt: new Date().toISOString(),
            },
          ],
          "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
        });
        // 3. Update vendor wallet and sales (deduct balance, pendingBalance, and monthly sales)

        const vendorEarnings = refundData.vendorEarnings;
        const vendorTransactions = vendorData?.wallet?.transactions || [];
        const updatedVendorBalance = ((vendorData?.wallet?.balance || 0) - vendorEarnings);
        const updatedVendorPendingBalance = ((vendorData?.wallet?.pendingBalance || 0) - vendorEarnings);

        // Safe fallback for monthly sales update
        const refundMonth = getCurrentMonthKey(); // You can reuse the same helper function as before
        const prevMonthSales = vendorData?.stats?.monthlySales?.[refundMonth] || 0;
        const refundSalesTotal = refundData.subtotal + refundData.deliveryFee;
        const newMonthSales = Math.max(prevMonthSales - refundSalesTotal, 0);

        transaction.update(vendorRef, {
          "wallet.balance": updatedVendorBalance,
          "wallet.pendingBalance": updatedVendorPendingBalance,
          "wallet.transactions": [
            ...vendorTransactions,
            {
              type: "debit",
              status: "success",
              source: "refund",
              amount: vendorEarnings,
              reference: transferRes.data.data.reference,
              vendorId,
              createdAt: new Date().toISOString(),
            },
          ],
          [`stats.monthlySales.${refundMonth}`]: newMonthSales,
          "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      return {success: true, message: "Refund processed successfully."};
    } catch (error) {
      console.error("Refund approval error:", error);
      throw new HttpsError("internal", "Refund approval failed.");
    }
  });
