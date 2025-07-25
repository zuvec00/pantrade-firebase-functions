import * as https from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";
import {admin, db} from "../firebase";
import axios from "axios";
import {calculateAmount} from "../paystack/paystack.utils";

export const getPaystackHeaders = (isLive = false) => {
  const secretKey = isLive ?
    process.env.PAYSTACK_LIVE_SECRET_KEY :
    process.env.PAYSTACK_TEST_SECRET_KEY;

  if (!secretKey) throw new Error("Paystack secret key not set");

  return {
    "Authorization": `Bearer ${secretKey}`,
    "Content-Type": "application/json",
  };
};


export const requestVendorWithdrawal = https.onCall({
  // Remove any security constraints for now
  enforceAppCheck: true, // optional
}, async (request) => {
  const {vendorId, amount, bankName, bankCode, accountNumber, accountName} = request.data;

  if (!vendorId || !amount || !bankName || !accountNumber || !accountName) {
    throw new HttpsError("invalid-argument", "Missing required fields.");
  }

  const vendorRef = db.collection("users").doc(vendorId);
  const withdrawalRef = db.collection("withdrawalRequest").doc();

  try {
    await db.runTransaction(async (transaction) => {
      const vendorDoc = await transaction.get(vendorRef);
      if (!vendorDoc.exists) {
        throw new HttpsError("not-found", "Vendor not found.");
      }

      const wallet = vendorDoc.data()?.wallet || {};
      const eligibleBalance = wallet.eligibleBalance || 0;

      if (eligibleBalance < amount) {
        throw new HttpsError("failed-precondition", "Insufficient eligible balance.");
      }

      transaction.update(vendorRef, {
        "wallet.eligibleBalance": eligibleBalance - amount,
        "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.set(withdrawalRef, {
        vendorId,
        amount,
        bankName,
        bankCode,
        accountNumber,
        accountName,
        status: "pending",
        requestedAt: admin.firestore.Timestamp.now(),
      });
    });

    return {success: true, message: "Withdrawal request submitted."};
  } catch (error) {
    console.error("Withdrawal request failed:", error);
    throw new HttpsError("internal", "Withdrawal request failed.");
  }
});

export const rejectVendorWithdrawal = https.onCall({enforceAppCheck: true}, async (request) => {
  const {withdrawalId, reason} = request.data;

  if (!withdrawalId) {
    throw new HttpsError("invalid-argument", "Missing withdrawalId.");
  }

  const withdrawalRef = db.collection("withdrawalRequest").doc(withdrawalId);

  try {
    await db.runTransaction(async (transaction) => {
      const withdrawalDoc = await transaction.get(withdrawalRef);

      if (!withdrawalDoc.exists) {
        throw new HttpsError("not-found", "Withdrawal request not found.");
      }

      const withdrawalData = withdrawalDoc.data();
      if (!withdrawalData) {
        throw new HttpsError("not-found", "Withdrawal data not found.");
      }

      if (withdrawalData.status !== "pending") {
        throw new HttpsError("failed-precondition", "Only pending withdrawals can be rejected.");
      }

      const vendorId = withdrawalData.vendorId;
      const amount = withdrawalData.amount;

      const vendorRef = db.collection("users").doc(vendorId);
      const vendorDoc = await transaction.get(vendorRef);

      if (!vendorDoc.exists) {
        throw new HttpsError("not-found", "Vendor not found.");
      }

      const eligibleBalance = vendorDoc.data()?.wallet?.eligibleBalance ?? 0;

      transaction.update(vendorRef, {
        "wallet.eligibleBalance": eligibleBalance + amount,
        "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.update(withdrawalRef, {
        status: "rejected",
        rejectionReason: reason || "Rejected by admin",
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return {success: true, message: "Withdrawal rejected and balance restored."};
  } catch (error) {
    console.error("Withdrawal rejection failed:", error);
    throw new HttpsError("internal", "Withdrawal rejection failed.", error);
  }
});

export const approveVendorWithdrawal = https.onCall(
  {
    secrets: ["PAYSTACK_TEST_SECRET_KEY", "PAYSTACK_LIVE_SECRET_KEY"],
    enforceAppCheck: true,
  },
  async (request) => {
    const {withdrawalId, isLive} = request.data;

    if (!withdrawalId) {
      throw new HttpsError("invalid-argument", "Missing withdrawal ID.");
    }

    const withdrawalRef = db.collection("withdrawalRequest").doc(withdrawalId);

    try {
      await db.runTransaction(async (transaction) => {
        const withdrawalDoc = await transaction.get(withdrawalRef);
        if (!withdrawalDoc.exists) {
          throw new HttpsError("not-found", "Withdrawal request not found.");
        }

        const withdrawalData = withdrawalDoc.data();
        if (!withdrawalData) {
          throw new HttpsError("not-found", "Withdrawal data missing.");
        }

        if (withdrawalData.status !== "pending") {
          throw new HttpsError("failed-precondition", "Withdrawal already processed.");
        }

        const vendorRef = db.collection("users").doc(withdrawalData.vendorId);
        const vendorDoc = await transaction.get(vendorRef);
        if (!vendorDoc.exists) {
          throw new HttpsError("not-found", "Vendor not found.");
        }

        const vendorData = vendorDoc.data();
        const transactions = vendorData?.wallet?.transactions || [];

        // AFTER all reads, do Paystack API actions
        const headers = getPaystackHeaders(isLive);
        const payload = {
          source: "balance",
          amount: calculateAmount(withdrawalData.amount),
          recipient: {
            type: "nuban",
            name: withdrawalData.accountName,
            account_number: withdrawalData.accountNumber,
            bank_code: withdrawalData.bankCode,
            currency: "NGN",
          },
          reason: `Vendor withdrawal for ₦${withdrawalData.amount}`,
        };

        // Step 1: Create Transfer Recipient
        const recipientRes = await axios.post(
          "https://api.paystack.co/transferrecipient",
          payload.recipient,
          {headers}
        );
        const recipientCode = recipientRes.data.data.recipient_code;

        // Step 2: Initiate Transfer
        const transferRes = await axios.post(
          "https://api.paystack.co/transfer",
          {
            source: "balance",
            amount: payload.amount,
            recipient: recipientCode,
            reason: payload.reason,
          },
          {headers}
        );

        // Step 3: Now do all writes
        transaction.update(withdrawalRef, {
          status: "approved",
          transferReference: transferRes.data.data.reference,
          approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        transaction.update(vendorRef, {
          "wallet.balance": admin.firestore.FieldValue.increment(-withdrawalData.amount),
          "wallet.transactions": [
            ...transactions,
            {
              type: "debit",
              status: "success",
              source: "withdrawal",
              amount: withdrawalData.amount,
              reference: transferRes.data.data.reference,
              vendorId: withdrawalData.vendorId,
              createdAt: new Date().toISOString(),
            },
          ],
          "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      return {success: true, message: "Withdrawal approved and transferred."};
    } catch (error) {
      console.error("Approve withdrawal error:", error);
      throw new HttpsError("internal", "Approval failed.");
    }
  }
);
