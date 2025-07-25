import * as https from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";
import {admin, db} from "../firebase";
import {onSchedule} from "firebase-functions/scheduler";
import {sendOneSignalNotification} from "../onesignal/onesignal.utils";

interface ReferralHistory {
    referredCustomerId: string;
    pointsEarned: number;
    date: string;
}

interface ReferralModel {
    vendorId: string;
    storeName: string;
    vendorLogoUrl: string;
    totalReferralPoints: number;
    weeklyReferralPoints: number;
    referralCode: string;
    referredCustomersCount: number;
    successfulReferralsCount: number;
    referralHistory: ReferralHistory[];
    lastReferralUpdate: string;
    isActive: boolean;
    totalRewardsClaimed: number;
    lastLeaderboardPosition: number;
    totalFeaturedSpots: number;
}

export const addReferralForVendor = https.onCall({enforceAppCheck: true}, async (request) => {
  const {vendorId, referredCustomerId} = request.data;

  if (!vendorId || !referredCustomerId) {
    throw new HttpsError("invalid-argument", "Missing vendorId or referredCustomerId");
  }

  const vendorRef = db.collection("vendors").doc(vendorId);
  const referralRef = db.collection("referrals").doc(vendorId);

  try {
    await db.runTransaction(async (transaction) => {
      const vendorDoc = await transaction.get(vendorRef);
      if (!vendorDoc.exists) {
        throw new HttpsError("not-found", "Vendor not found");
      }
      const vendorData = vendorDoc.data();

      if (!vendorData) {
        throw new HttpsError("not-found", "Vendor data is undefined");
      }

      const referralDoc = await transaction.get(referralRef);
      const now = admin.firestore.Timestamp.now();
      const nowIso = now.toDate().toISOString();

      if (referralDoc.exists) {
        const data = referralDoc.data() as ReferralModel;
        const updatedReferralHistory = [
          ...(data.referralHistory || []),
          {
            referredCustomerId,
            pointsEarned: 10,
            date: nowIso,
          },
        ];

        transaction.update(referralRef, {
          totalReferralPoints: admin.firestore.FieldValue.increment(10),
          weeklyReferralPoints: admin.firestore.FieldValue.increment(10),
          referredCustomersCount: admin.firestore.FieldValue.increment(1),
          referralHistory: updatedReferralHistory,
          lastReferralUpdate: nowIso,
          isActive: true,
        });
      } else {
        const referralModel: ReferralModel = {
          vendorId,
          storeName: vendorData.name,
          vendorLogoUrl: vendorData.logoUrl || "",
          totalReferralPoints: 10,
          weeklyReferralPoints: 10,
          referralCode: vendorData.referralCode || "",
          referredCustomersCount: 1,
          successfulReferralsCount: 0,
          referralHistory: [
            {
              referredCustomerId,
              pointsEarned: 10,
              date: nowIso,
            },
          ],
          lastReferralUpdate: nowIso,
          isActive: true,
          totalRewardsClaimed: 0,
          lastLeaderboardPosition: 0,
          totalFeaturedSpots: 0,
        };
        transaction.set(referralRef, referralModel);
      }
    });

    return {success: true};
  } catch (error) {
    console.error("Error adding referral:", error);
    throw new HttpsError("internal", "Failed to add referral", error);
  }
});

export const updateReferralPointsOnPurchase = https.onCall({enforceAppCheck: true}, async (request) => {
  const {vendorId, referredCustomerId, orderId} = request.data;

  if (!vendorId || !referredCustomerId || !orderId) {
    throw new HttpsError(
      "invalid-argument",
      "Missing required fields: vendorId, referredCustomerId, or orderId"
    );
  }

  const referralRef = db.collection("referrals").doc(vendorId);

  try {
    await db.runTransaction(async (transaction) => {
      const referralDoc = await transaction.get(referralRef);

      if (!referralDoc.exists) {
        throw new HttpsError("not-found", "Referral record not found");
      }

      const referralData = referralDoc.data() as ReferralModel;

      // Check if this customer is in the referral history
      const hasReferral = referralData.referralHistory.some(
        (history) => history.referredCustomerId === referredCustomerId
      );

      if (!hasReferral) {
        throw new HttpsError(
          "failed-precondition",
          "Customer was not referred by this vendor"
        );
      }

      const now = admin.firestore.Timestamp.now();
      const nowIso = now.toDate().toISOString();

      // Add new history entry for the purchase points
      const updatedReferralHistory = [
        ...referralData.referralHistory,
        {
          referredCustomerId,
          pointsEarned: 40,
          date: nowIso,
          orderId, // Optional: track which order earned these points
        },
      ];

      // Update the referral document
      transaction.update(referralRef, {
        totalReferralPoints: admin.firestore.FieldValue.increment(40),
        weeklyReferralPoints: admin.firestore.FieldValue.increment(40),
        successfulReferralsCount: admin.firestore.FieldValue.increment(1),
        referralHistory: updatedReferralHistory,
        lastReferralUpdate: nowIso,
      });
    });

    return {
      success: true,
      message: "Referral points updated for successful purchase",
    };
  } catch (error) {
    console.error("Error updating referral points:", error);
    throw new HttpsError(
      "internal",
      "Failed to update referral points",
      error
    );
  }
});

// TODO: PUSH THIS TO PROD

export const resetWeeklyLeaderboard = onSchedule({
  schedule: "every saturday 23:00",
  secrets: [
    "ONESIGNAL_VENDOR_APP_ID",
    "ONESIGNAL_VENDOR_API_KEY",
  ],
}, async (context) => {
  const configRef = db.doc("global/leaderboardSettings");

  const configDoc = await configRef.get();

  if (!configDoc.exists) return;

  const {nextResetTime} = configDoc.data()!;

  const batch = db.batch();

  const referralsSnapshot = await db.collection("referrals").get();
  referralsSnapshot.forEach((doc) => {
    batch.update(doc.ref, {
      weeklyReferralPoints: 0,
    });
  });

  batch.update(configRef, {
    currentResetStart: nextResetTime,
    nextResetTime: admin.firestore.Timestamp.fromDate(
      new Date(nextResetTime.toDate().getTime() + 7 * 24 * 60 * 60 * 1000)
    ),
  });

  await batch.commit();

  // Send notifications to all vendors
  try {
    // First notification about the weekly reset
    await sendOneSignalNotification({
      headings: {en: "🚀 New Week, New Chance: Leaderboard Reset! ⏳"},
      contents: {en: "Game on! 🏆 Top vendors are already sharing their codes. Join the race for rewards and featured spots!"},
      included_segments: ["All Vendors"],
    }, "vendor");

    // Second notification about the referral opportunity - sent 5 minutes after reset
    setTimeout(async () => {
      await sendOneSignalNotification({
        headings: {en: "🌟 Earn Your Spotlight: Top Referrer This Week!"},
        contents: {en: "Bring in customers this week to earn a prime PanTrade spotlight — more referrals, more visibility and sales!"},
        included_segments: ["All Vendors"],
      }, "vendor");
    }, 5 * 60 * 1000); // 5 minutes in milliseconds

    console.log("Successfully sent leaderboard reset notifications to vendors");
  } catch (error) {
    console.error("Error sending leaderboard reset notifications:", error);
    // Don't throw the error as we don't want to fail the entire reset process
    // just because notifications failed
  }
});
