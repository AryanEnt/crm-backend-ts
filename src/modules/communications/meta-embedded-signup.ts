import { truncateBytes } from "../../lib/go-strings.js";

type Json = Record<string, unknown>;

export type MetaWhatsAppEnv = {
  appId: string;
  appSecret: string;
  configId: string;
  verifyToken: string;
  graphApiVersion: string;
  publicApiUrl: string;
};

export function metaWhatsAppConfigured(env: MetaWhatsAppEnv): boolean {
  return env.appId.trim() !== "" && env.appSecret.trim() !== "" && env.configId.trim() !== "";
}

/** Exchange Embedded Signup code for a customer business token (code TTL ~30s). */
export async function exchangeEmbeddedSignupCode(
  env: MetaWhatsAppEnv,
  code: string,
): Promise<{ accessToken: string; raw: Json | null }> {
  const ver = env.graphApiVersion || "v21.0";
  const url = new URL(`https://graph.facebook.com/${ver}/oauth/access_token`);
  url.searchParams.set("client_id", env.appId);
  url.searchParams.set("client_secret", env.appSecret);
  url.searchParams.set("code", code);
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let raw: Json | null = null;
  try {
    const v: unknown = JSON.parse(text);
    raw = v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    raw = null;
  }
  if (res.status >= 300) {
    throw new Error(`meta token exchange failed (${res.status}): ${truncateBytes(text, 400)}`);
  }
  const token = typeof raw?.access_token === "string" ? raw.access_token : "";
  if (token === "") throw new Error("meta token exchange returned no access_token");
  return { accessToken: token, raw };
}

/** Subscribe the platform app to the customer's WABA so webhooks are delivered. */
export async function subscribeWaba(env: MetaWhatsAppEnv, wabaId: string, accessToken: string): Promise<void> {
  const ver = env.graphApiVersion || "v21.0";
  const res = await fetch(`https://graph.facebook.com/${ver}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (res.status >= 300) {
    throw new Error(`meta waba subscribe failed (${res.status}): ${truncateBytes(text, 400)}`);
  }
}

export async function fetchPhoneDisplayNumber(
  env: MetaWhatsAppEnv,
  phoneNumberId: string,
  accessToken: string,
): Promise<string> {
  const ver = env.graphApiVersion || "v21.0";
  const res = await fetch(
    `https://graph.facebook.com/${ver}/${phoneNumberId}?fields=display_phone_number,verified_name`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const text = await res.text();
  if (res.status >= 300) return "";
  try {
    const v: unknown = JSON.parse(text);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const display = (v as Json).display_phone_number;
      return typeof display === "string" ? display : "";
    }
  } catch {
    // ignore
  }
  return "";
}

/** Best-effort Cloud API registration; ignore if already registered. */
export async function registerPhoneNumber(
  env: MetaWhatsAppEnv,
  phoneNumberId: string,
  accessToken: string,
  pin: string,
): Promise<void> {
  if (pin.trim() === "") return;
  const ver = env.graphApiVersion || "v21.0";
  const res = await fetch(`https://graph.facebook.com/${ver}/${phoneNumberId}/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", pin: pin.trim() }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status >= 300) {
    const text = await res.text();
    // Already registered / in use is fine for reconnect flows.
    if (/already|registered|exists/i.test(text)) return;
    throw new Error(`meta phone register failed (${res.status}): ${truncateBytes(text, 400)}`);
  }
}
