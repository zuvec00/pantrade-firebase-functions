// File: functions/src/paystack/paystack.utils.ts
import * as functions from "firebase-functions/v2/https";
import axios from "axios";


const PAYSTACK_BASE_URL = "https://api.paystack.co";

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

export const calculateAmount = (amountInNaira: number): number => {
  return amountInNaira * 100; // Convert to Kobo
};

// =============================
// Initialize Transaction
// =============================
export const initializeTransaction = functions.onCall(
  {
    secrets: ["PAYSTACK_TEST_SECRET_KEY", "PAYSTACK_LIVE_SECRET_KEY"],
    enforceAppCheck: true,
  },
  async (request) => {
    const {
      email,
      amount,
      subaccountCode,
      reference,
      callbackUrl,
      metadata,
      isLive,
    }: {
      email: string;
      amount: number;
      subaccountCode?: string;
      reference: string;
      callbackUrl?: string;
      metadata?: any;
      isLive?: boolean;
    } = request.data;

    if (!email || !amount || !reference) {
      throw new functions.HttpsError("invalid-argument", "Missing required fields.");
    }

    const headers = getPaystackHeaders(isLive);
    const payload: any = {
      email,
      amount: calculateAmount(amount),
      reference,
      currency: "NGN",
    };

    if (callbackUrl) payload.callback_url = callbackUrl;
    if (subaccountCode) payload.subaccount = subaccountCode;
    if (metadata) payload.metadata = metadata;

    try {
      const response = await axios.post(
        `${PAYSTACK_BASE_URL}/transaction/initialize`,
        payload,
        {headers}
      );

      return response.data;
    } catch (error: unknown) {
      console.error("Paystack init error:", (error as any).response?.data || error);
      throw new functions.HttpsError("internal", "Transaction initialization failed.");
    }
  }
);

// =============================
// Verify Transaction
// =============================
export const verifyTransaction = functions.onCall(
  {
    secrets: ["PAYSTACK_TEST_SECRET_KEY", "PAYSTACK_LIVE_SECRET_KEY"],
    enforceAppCheck: true,
  },
  async (request) => {
    const {
      reference,
      isLive,
    }: {
      reference: string;
      isLive?: boolean;
    } = request.data;

    if (!reference) {
      throw new functions.HttpsError("invalid-argument", "Missing reference.");
    }

    const headers = getPaystackHeaders(isLive);

    try {
      const response = await axios.get(
        `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
        {headers}
      );

      return response.data;
    } catch (error: unknown) {
      console.error("Paystack verify error:", (error as any).response?.data || error);
      throw new functions.HttpsError("internal", "Transaction verification failed.");
    }
  }
);

export const getBankList = functions.onCall(
  {
    secrets: ["PAYSTACK_TEST_SECRET_KEY", "PAYSTACK_LIVE_SECRET_KEY"],
    enforceAppCheck: true,
  },
  async (request) => {
    const {isLive} = request.data;
    const headers = getPaystackHeaders(isLive);

    try {
      const response = await axios.get(`${PAYSTACK_BASE_URL}/bank`, {
        headers,
      });

      return response.data;
    } catch (error: any) {
      console.error("Paystack bank list error:", error.response?.data || error.message);
      throw new functions.HttpsError("internal", "Failed to fetch bank list");
    }
  }
);

export const verifyAccount = functions.onCall(
  {
    secrets: ["PAYSTACK_TEST_SECRET_KEY", "PAYSTACK_LIVE_SECRET_KEY"],
    enforceAppCheck: true,
  },
  async (request) => {
    const {
      accountNumber,
      bankCode,
      isLive,
    }: {
      accountNumber: string;
      bankCode: string;
      isLive?: boolean;
    } = request.data;

    if (!accountNumber || !bankCode) {
      throw new functions.HttpsError("invalid-argument", "Missing required fields.");
    }

    const headers = getPaystackHeaders(isLive);
    const url = `${PAYSTACK_BASE_URL}/bank/resolve`;
    const params = {account_number: accountNumber, bank_code: bankCode};

    try {
      const response = await axios.get(url, {
        headers,
        params,
      });

      return response.data; // This will contain status and data.account_name
    } catch (error: any) {
      console.error("Paystack verify account error:", error.response?.data || error.message);
      throw new functions.HttpsError("internal", "Failed to verify account");
    }
  }
);
export const createSubaccount = functions.onCall(
  {
    secrets: ["PAYSTACK_TEST_SECRET_KEY", "PAYSTACK_LIVE_SECRET_KEY"],
    enforceAppCheck: true,
  },
  async (request) => {
    const {
      businessName,
      bankCode,
      accountNumber,
      percentageCharge,
      isLive,
    }: {
      businessName: string;
      bankCode: string;
      accountNumber: string;
      percentageCharge: number;
      isLive?: boolean;
    } = request.data;

    const headers = getPaystackHeaders(isLive);
    const payload = {
      business_name: businessName,
      bank_code: bankCode,
      account_number: accountNumber,
      percentage_charge: percentageCharge,
    };

    try {
      const response = await axios.post(`${PAYSTACK_BASE_URL}/subaccount`, payload, {
        headers,
      });

      return response.data;
    } catch (error: any) {
      console.error("Paystack subaccount error:", error.response?.data || error);
      throw new functions.HttpsError("internal", "Subaccount creation failed.");
    }
  }
);
