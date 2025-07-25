import * as functions from "firebase-functions/v2/https";
import {sendOneSignalNotification} from "./onesignal.utils";

export const sendGenericNotification = functions.onCall(
  {
    secrets: [
      "ONESIGNAL_VENDOR_APP_ID",
      "ONESIGNAL_VENDOR_API_KEY",
      "ONESIGNAL_CUSTOMER_APP_ID",
      "ONESIGNAL_CUSTOMER_API_KEY",
    ],
    enforceAppCheck: true,
  },
  async (request) => {
    const {
      title,
      content,
      externalUserIds = [],
      segment = null,
      audience = "vendor", // default to vendor
    }: {
      title: string;
      content: string;
      externalUserIds?: string[];
      segment?: string | null;
      audience?: "vendor" | "customer";
    } = request.data;

    // Validate inputs
    if (!title || !content) {
      throw new functions.HttpsError("invalid-argument", "Missing title or content.");
    }

    // Build OneSignal payload
    const payload: any = {
      headings: {en: title},
      contents: {en: content},
    };

    if (segment) {
      payload.included_segments = [segment];
    } else if (externalUserIds.length > 0) {
      payload.include_external_user_ids = externalUserIds;
    } else {
      throw new functions.HttpsError("invalid-argument", "Must provide externalUserIds or segment.");
    }

    // Send the notification
    try {
      const response = await sendOneSignalNotification(payload, audience);
      return {success: true, data: response};
    } catch (error: any) {
      console.error("Notification error:", error.response?.data || error.message);
      throw new functions.HttpsError("internal", "Notification failed.");
    }
  }
);
