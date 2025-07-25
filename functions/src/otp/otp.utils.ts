import axios from "axios";
import * as logger from "firebase-functions/logger";
import * as https from "firebase-functions/v2/https";
import * as scheduler from "firebase-functions/v2/scheduler";
import * as bcrypt from "bcrypt";
import {HttpsError} from "firebase-functions/v2/https";

interface OtpPayload {
  email: string;
  otp: string;
}

import {admin, db} from "../firebase";

const OTP_COLLECTION = "otp_codes";
const OTP_EXPIRY_MINUTES = 5;

// Helper: Generate 6-digit OTP
const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

export const sendOtpToEmail = https.onCall(
  {
    secrets: ["BREVO_API_KEY"],
    enforceAppCheck: true,
  },
  async (request: https.CallableRequest<OtpPayload>) => {
    const {email} = request.data;
    const otp = generateOtp();
    const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000));

    // Save to Firestore
    await db.collection(OTP_COLLECTION).doc(email).set({
      code: otp,
      expiresAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const mailData = {
      sender: {
        name: "PanTrade",
        email: "pantradeng@gmail.com",
      },
      to: [{email}],
      subject: "Your OTP Code",
      htmlContent: `
        <div style="font-family: sans-serif; font-size: 16px;">
          <p>Hi there,</p>
          <p>Your OTP is: <strong style="font-size: 20px;">${otp}</strong></p>
          <p>This code expires in 5 minutes.</p>
        </div>
      `,
    };

    try {
      await axios.post("https://api.brevo.com/v3/smtp/email", mailData, {
        headers: {
          "api-key": process.env.BREVO_API_KEY!,
          "Content-Type": "application/json",
        },
      });

      return {success: true};
    } catch (error: unknown) {
      console.error("Email send error:", error);
      throw new HttpsError("internal", "Failed to send email");
    }
  }
);
export const verifyOtp = https.onCall({enforceAppCheck: true}, async (request: https.CallableRequest<OtpPayload>) => {
  const {email, otp} = request.data;
  if (!email || !otp) throw new HttpsError("invalid-argument", "Email and OTP are required.");

  const doc = await db.collection(OTP_COLLECTION).doc(email).get();
  if (!doc.exists) throw new HttpsError("not-found", "OTP not found.");

  const {code, expiresAt} = doc.data()!;
  if (code !== otp) throw new HttpsError("permission-denied", "Invalid OTP.");

  const now = admin.firestore.Timestamp.now();
  if (expiresAt.toMillis() < now.toMillis()) {
    await db.collection(OTP_COLLECTION).doc(email).delete();
    throw new HttpsError("deadline-exceeded", "OTP has expired.");
  }

  await db.collection(OTP_COLLECTION).doc(email).delete();
  return {success: true};
});

export const cleanExpiredOtps = scheduler.onSchedule("every 5 minutes", async () => {
  const now = admin.firestore.Timestamp.now();
  const expired = await db.collection(OTP_COLLECTION).where("expiresAt", "<", now).get();

  const batch = db.batch();
  expired.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  logger.log(`Cleaned up ${expired.size} expired OTP(s)`);
});
export const saveTransactionPin = https.onCall(
  async (request: https.CallableRequest<{pin: string}>) => {
    const {pin} = request.data;

    if (!request.auth || !request.auth.uid) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }

    const uid = request.auth.uid;

    if (!pin || typeof pin !== "string" || pin.length < 4) {
      throw new HttpsError("invalid-argument", "Invalid PIN format.");
    }

    const saltRounds = 10;
    const hashedPin = await bcrypt.hash(pin, saltRounds);

    await db
      .collection("users")
      .doc(uid)
      .collection("security")
      .doc("transactionPin")
      .set({
        pinHash: hashedPin,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    return {success: true};
  }
);

export const verifyTransactionPin = https.onCall(
  {
    enforceAppCheck: true,
  },
  async (request: https.CallableRequest<{pin: string}>) => {
    const {pin} = request.data;

    if (!request.auth || !request.auth.uid) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }

    const uid = request.auth.uid;

    if (!pin || typeof pin !== "string" || pin.length < 4) {
      throw new HttpsError("invalid-argument", "Invalid PIN format.");
    }

    const doc = await db
      .collection("users")
      .doc(uid)
      .collection("security")
      .doc("transactionPin")
      .get();

    if (!doc.exists) {
      throw new HttpsError("not-found", "Transaction PIN not set.");
    }

    const hashed = doc.data()?.pinHash;

    const isValid = await bcrypt.compare(pin, hashed);

    if (!isValid) {
      throw new HttpsError("permission-denied", "Invalid transaction PIN.");
    }

    return {success: true};
  }
);
