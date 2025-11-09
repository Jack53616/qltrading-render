import crypto from "crypto";

export function checkTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get("hash");
  if (!hash) return false;
  urlParams.delete("hash");
  const dataCheckString = Array.from(urlParams.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const signature = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return signature === hash;
}

export function parseInitData(initData) {
  const params = new URLSearchParams(initData || "");
  const userRaw = params.get("user");
  if (!userRaw) return null;
  try {
    return JSON.parse(userRaw);
  } catch (err) {
    return null;
  }
}
