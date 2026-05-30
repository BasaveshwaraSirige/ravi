import { envOptional } from "./env";

export function normalizePhoneNumbers(raw: string | undefined, defaultCountryCode: string) {
  if (!raw) return [];
  const nums = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return nums.map((n) => {
    if (n.startsWith("+")) return n;
    const digits = n.replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length === 10) return `${defaultCountryCode}${digits}`;
    if (digits.startsWith("0") && digits.length === 11 && defaultCountryCode === "+91") {
      return `${defaultCountryCode}${digits.slice(1)}`;
    }
    return `${defaultCountryCode}${digits}`;
  }).filter(Boolean);
}

export async function sendSms(to: string, body: string) {
  const accountSid = envOptional("TWILIO_ACCOUNT_SID");
  const authToken = envOptional("TWILIO_AUTH_TOKEN");
  const from = envOptional("TWILIO_FROM_NUMBER");

  if (!accountSid || !authToken || !from) {
    // eslint-disable-next-line no-console
    console.log(`[sms] (dry-run) To=${to} Body=${body}`);
    return { ok: true, dryRun: true };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams();
  params.set("To", to);
  params.set("From", from);
  params.set("Body", body);

  const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // eslint-disable-next-line no-console
    console.log(`[sms] Twilio error: ${res.status} ${text}`);
    return { ok: false, status: res.status, error: text };
  }

  return { ok: true };
}

