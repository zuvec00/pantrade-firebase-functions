import * as https from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";
import {admin, db} from "../firebase";
import {onSchedule} from "firebase-functions/scheduler";
import {sendOneSignalNotification} from "../onesignal/onesignal.utils";

interface Reward {
    userId: string;
    rewardType: "free_delivery_350" | "free_delivery_200" | "no_service_charge_1x" |
    "1000_naira_off" | "500_naira_off" | "none";
    referrerVendorId?: string;
    createdAt: admin.firestore.Timestamp;
    expiresAt: admin.firestore.Timestamp;
    isUsed: boolean;
    isActive: boolean;
    usedAt?: admin.firestore.Timestamp;
    appliedToOrderId?: string;
    rewardValue?: number;
    channel: "referral_signup_spin" | "admin" | string;
}

interface NotificationConfig {
  headings: { en: string };
  contents: { en: string };
  include_external_user_ids?: string[];
}

export const addReward = https.onCall({enforceAppCheck: true}, async (request) => {
  const rewardData = request.data;

  if (!rewardData) {
    throw new HttpsError("invalid-argument", "Missing reward data");
  }

  try {
    const rewardsRef = db.collection("rewards");

    const reward: Reward = {
      ...rewardData,
      createdAt: admin.firestore.Timestamp.now(),
      isUsed: false,
      isActive: true,
    };

    const docRef = await rewardsRef.add(reward);

    return {
      success: true,
      rewardId: docRef.id,
      reward,
    };
  } catch (error) {
    console.error("Error adding reward:", error);
    throw new HttpsError("internal", "Failed to add reward", error);
  }
});


export const markRewardAsUsed = https.onCall({enforceAppCheck: true}, async (request) => {
  const {rewardId, orderId} = request.data;

  if (!rewardId || !orderId) {
    throw new HttpsError(
      "invalid-argument",
      "Missing required fields: rewardId and orderId"
    );
  }

  try {
    const rewardRef = db.collection("rewards").doc(rewardId);
    const rewardDoc = await rewardRef.get();

    if (!rewardDoc.exists) {
      throw new HttpsError("not-found", "Reward not found");
    }

    const rewardData = rewardDoc.data();

    // Check if reward is already used
    if (rewardData?.isUsed) {
      throw new HttpsError(
        "failed-precondition",
        "Reward has already been used"
      );
    }

    // Update the reward document
    await rewardRef.update({
      isUsed: true,
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
      appliedToOrderId: orderId,
    });

    return {
      success: true,
      message: "Reward marked as used",
    };
  } catch (error) {
    console.error("Error marking reward as used:", error);
    throw new HttpsError(
      "internal",
      "Failed to mark reward as used",
      error
    );
  }
});

// TODO: PUSH THIS TO PROD
export const checkExpiringRewards = onSchedule({
  schedule: "every 2 hours",
  secrets: [
    "ONESIGNAL_CUSTOMER_APP_ID",
    "ONESIGNAL_CUSTOMER_API_KEY",
  ],
}, async (context) => {
  const now = admin.firestore.Timestamp.now();
  const rewardsRef = db.collection("rewards");

  try {
    // Get all non-expired, unused rewards
    const rewardsSnapshot = await rewardsRef.where("isUsed", "==", false)
      .where("expiresAt", ">", now)
      .get();

    const notificationPromises: Promise<any>[] = [];

    rewardsSnapshot.forEach((doc) => {
      const reward = doc.data();
      const expiresAt = reward.expiresAt.toDate();
      const timeUntilExpiry = expiresAt.getTime() - now.toDate().getTime();
      const hoursUntilExpiry = timeUntilExpiry / (1000 * 60 * 60);

      // Don't send notifications for rewards that have already been notified at this interval
      const lastNotificationTime = reward.lastNotificationTime?.toDate().getTime() || 0;
      const timeSinceLastNotification = now.toDate().getTime() - lastNotificationTime;
      const hoursSinceLastNotification = timeSinceLastNotification / (1000 * 60 * 60);

      // Only send one notification per interval
      if (hoursSinceLastNotification < 12) return;

      let notificationConfig: NotificationConfig | null = null;

      // 3 days to expiry (between 71-73 hours)
      if (hoursUntilExpiry <= 73 && hoursUntilExpiry > 71) {
        notificationConfig = {
          headings: {en: "🎁 Only 3 Days Left! Claim Your Reward!"},
          contents: {en: `Your ${reward.rewardType} reward expires soon — use it before it's gone!`},
        };
      } else if (hoursUntilExpiry <= 25 && hoursUntilExpiry > 23) {
        notificationConfig = {
          headings: {en: "⚡️ Last Chance! 24 Hours to Use Your Reward"},
          contents: {en: `Don't miss out — redeem your  ${reward.rewardType} reward before midnight!`},
        };
      } else if (hoursUntilExpiry <= 3.5 && hoursUntilExpiry > 2.5) {
        notificationConfig = {
          headings: {en: "⏰ Hurry! Reward Expires in 2 Hours"},
          contents: {en: "This is your last chance — claim your reward before it expires!"},
        };
      } else if (hoursUntilExpiry <= 0 && hoursUntilExpiry > -1) {
        notificationConfig = {
          headings: {en: "❌ 😭  Reward Expired"},
          contents: {en: `Oh no! Your ${reward.rewardType} reward has expired.`},
        };
      }

      if (notificationConfig) {
        // Add user ID to notification
        notificationConfig.include_external_user_ids = [reward.userId];

        // Send notification and update last notification time
        const notificationPromise = Promise.all([
          sendOneSignalNotification(notificationConfig, "customer"),
          doc.ref.update({
            lastNotificationTime: now,
            notificationsSent: admin.firestore.FieldValue.increment(1),
          }),
        ]);

        notificationPromises.push(notificationPromise);
      }
    });

    await Promise.all(notificationPromises);
    console.log(`Successfully processed ${notificationPromises.length} reward expiry notifications`);
  } catch (error) {
    console.error("Error checking expiring rewards:", error);
    // Don't throw the error as this is a scheduled function
  }
});


