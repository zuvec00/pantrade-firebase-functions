import axios from "axios";
const ONESIGNAL_BASE_URL = "https://api.onesignal.com";

export const getOneSignalHeaders = (audience: "vendor" | "customer") => {
  const apiKey =
    audience === "vendor"?
      process.env.ONESIGNAL_VENDOR_API_KEY:
      process.env.ONESIGNAL_CUSTOMER_API_KEY;

  if (!apiKey) throw new Error("OneSignal API key not set");

  return {
    "Authorization": `Basic ${apiKey}`,
    "Content-Type": "application/json",
  };
};

export const getAppId = (audience: "vendor" | "customer") => {
  return audience === "vendor"?
    process.env.ONESIGNAL_VENDOR_APP_ID:
    process.env.ONESIGNAL_CUSTOMER_APP_ID;
};

export const sendOneSignalNotification = async (
  payload: any,
  audience: "vendor" | "customer"
) => {
  const headers = getOneSignalHeaders(audience);
  const url = `${ONESIGNAL_BASE_URL}/notifications`;

  const finalPayload = {
    app_id: getAppId(audience),
    ...payload,
  };

  const response = await axios.post(url, finalPayload, {headers});
  return response.data;
};
