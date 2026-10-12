import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { goV } from "../../lib/go-fmt.js";
import { truncateBytes } from "../../lib/go-strings.js";

export const ProviderMetaWhatsApp = "meta_whatsapp";
export const ProviderTwilioVoice = "twilio_voice";
export const DirectionInbound = "inbound";
export const DirectionOutbound = "outbound";

type Json = Record<string, unknown>;
export type Form = Map<string, string[]>;

export interface OutboundMessageRequest {
  toPhoneNumberId: string;
  to: string;
  body: string;
  mediaUrl: string;
  accessToken: string;
  graphApiVersion: string;
}

export interface OutboundMessageResult {
  providerMessageId: string;
  raw: Json | null;
}

export interface InboundWhatsAppEvent {
  kind: "message" | "status";
  phoneNumberId: string;
  providerMessageId: string;
  status: string;
  from: string;
  to: string;
  body: string;
  mediaUrl: string;
  mediaMime: string;
  mediaFilename: string;
  timestamp: Date;
  raw: Json | null;
  /** Stable idempotency key. */
  eventKey: string;
}

export interface OutboundCallRequest {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  statusCallbackUrl: string;
  twimlUrl: string;
}

export interface OutboundCallResult {
  callSid: string;
  status: string;
  raw: Json | null;
}

export interface CallStatusEvent {
  callSid: string;
  accountSid: string;
  from: string;
  to: string;
  callStatus: string;
  direction: string;
  duration: number | null;
  recordingSid: string;
  recordingUrl: string;
  timestamp: Date;
  eventKey: string;
  raw: Json;
}

/** Meta WhatsApp Cloud API, isolated from the rest of the CRM. WhatsApp never goes through Twilio. */
export interface WhatsAppProvider {
  send(req: OutboundMessageRequest): Promise<OutboundMessageResult>;
  verifyWebhook(mode: string, token: string, challenge: string, verifyToken: string): string | null;
  validateSignature(appSecret: string, body: Buffer, signatureHeader: string): boolean;
  parseWebhook(body: Buffer): InboundWhatsAppEvent[];
}

/** Twilio Voice, isolated from the rest of the CRM. */
export interface TwilioProvider {
  placeCall(req: OutboundCallRequest): Promise<OutboundCallResult>;
  validateSignature(authToken: string, fullUrl: string, form: Form, signatureHeader: string): boolean;
  parseStatusCallback(form: Form): CallStatusEvent;
}

const HTTP_TIMEOUT_MS = 20_000;

/** Decodes like json.Unmarshal into map[string]any with the error ignored: null unless an object. */
function jsonObject(text: string): Json | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

const asObject = (v: unknown): Json | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const asArray = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class MetaWhatsAppProvider implements WhatsAppProvider {
  async send(req: OutboundMessageRequest): Promise<OutboundMessageResult> {
    if (req.accessToken.trim() === "" || req.toPhoneNumberId.trim() === "") {
      throw new Error("meta whatsapp credentials incomplete");
    }
    const ver = req.graphApiVersion || "v21.0";
    const payload: Json =
      req.mediaUrl.trim() !== ""
        ? { image: { link: req.mediaUrl }, messaging_product: "whatsapp", to: normalizePhone(req.to), type: "image" }
        : { messaging_product: "whatsapp", text: { body: req.body }, to: normalizePhone(req.to), type: "text" };
    const res = await fetch(`https://graph.facebook.com/${ver}/${req.toPhoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${req.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    const raw = jsonObject(text);
    if (res.status >= 300) throw new Error(`meta whatsapp send failed (${res.status}): ${truncateBytes(text, 400)}`);
    const first = asObject(asArray(raw?.messages)?.[0]);
    const msgId = str(first?.id);
    return { providerMessageId: msgId || `wamid.${randomUUID()}`, raw };
  }

  verifyWebhook(mode: string, token: string, challenge: string, verifyToken: string): string | null {
    return mode === "subscribe" && token !== "" && token === verifyToken ? challenge : null;
  }

  validateSignature(appSecret: string, body: Buffer, signatureHeader: string): boolean {
    if (appSecret === "") return false;
    const sig = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : signatureHeader;
    const expected = createHmac("sha256", appSecret).update(body).digest("hex");
    return constantTimeEqual(Buffer.from(expected.toLowerCase()), Buffer.from(sig.toLowerCase()));
  }

  parseWebhook(body: Buffer): InboundWhatsAppEvent[] {
    // json.Unmarshal into a map: invalid JSON or a non-object fails; null yields no events.
    const root: unknown = JSON.parse(body.toString());
    if (root !== null && (typeof root !== "object" || Array.isArray(root))) throw new Error("invalid webhook payload");
    const out: InboundWhatsAppEvent[] = [];
    for (const e of asArray(asObject(root)?.entry) ?? []) {
      for (const ch of asArray(asObject(e)?.changes) ?? []) {
        const value = asObject(asObject(ch)?.value);
        const meta = asObject(value?.metadata);
        const phoneNumberId = str(meta?.phone_number_id);
        const displayPhone = str(meta?.display_phone_number);
        for (const st of asArray(value?.statuses) ?? []) {
          const sm = asObject(st);
          const id = str(sm?.id);
          const status = str(sm?.status);
          out.push({
            ...blankEvent(),
            kind: "status", phoneNumberId, providerMessageId: id, status, to: displayPhone,
            timestamp: parseUnix(asString(sm?.timestamp)), eventKey: `wa-status:${id}:${status}`, raw: sm,
          });
        }
        for (const msg of asArray(value?.messages) ?? []) {
          const mm = asObject(msg);
          const id = str(mm?.id);
          let bodyText = str(asObject(mm?.text)?.body);
          let mediaUrl = "";
          let mediaMime = "";
          let mediaFilename = "";
          const img = asObject(mm?.image);
          if (img) {
            mediaUrl = str(img.id);
            mediaMime = str(img.mime_type);
            bodyText = coalesce(bodyText, "[image attachment]");
          }
          const doc = asObject(mm?.document);
          if (doc) {
            mediaUrl = str(doc.id);
            mediaMime = str(doc.mime_type);
            mediaFilename = str(doc.filename);
            bodyText = coalesce(bodyText, "[document attachment]");
          }
          out.push({
            ...blankEvent(),
            kind: "message", phoneNumberId, providerMessageId: id, from: str(mm?.from), to: displayPhone,
            body: bodyText, mediaUrl, mediaMime, mediaFilename,
            timestamp: parseUnix(asString(mm?.timestamp)), eventKey: `wa-msg:${id}`, raw: mm,
          });
        }
      }
    }
    return out;
  }
}

const blankEvent = (): Omit<InboundWhatsAppEvent, "kind" | "timestamp" | "eventKey" | "raw"> => ({
  phoneNumberId: "", providerMessageId: "", status: "", from: "", to: "", body: "", mediaUrl: "", mediaMime: "", mediaFilename: "",
});

/** Simulates Meta WhatsApp when live credentials are absent. */
export class DevWhatsAppProvider implements WhatsAppProvider {
  private readonly meta = new MetaWhatsAppProvider();

  send(req: OutboundMessageRequest): Promise<OutboundMessageResult> {
    return Promise.resolve({ providerMessageId: `wamid.dev.${randomUUID()}`, raw: { simulated: true, to: req.to } });
  }

  verifyWebhook(mode: string, token: string, challenge: string, verifyToken: string): string | null {
    return this.meta.verifyWebhook(mode, token, challenge, verifyToken);
  }

  /** Local/dev accounts without a secret accept any signature. */
  validateSignature(appSecret: string, body: Buffer, signatureHeader: string): boolean {
    return appSecret === "" || this.meta.validateSignature(appSecret, body, signatureHeader);
  }

  parseWebhook(body: Buffer): InboundWhatsAppEvent[] {
    return this.meta.parseWebhook(body);
  }
}

export class TwilioVoiceProvider implements TwilioProvider {
  async placeCall(req: OutboundCallRequest): Promise<OutboundCallResult> {
    if (req.accountSid === "" || req.authToken === "") throw new Error("twilio credentials incomplete");
    const form: [string, string][] = [
      ["From", normalizePhone(req.from)],
      ["To", normalizePhone(req.to)],
    ];
    if (req.statusCallbackUrl !== "") {
      form.push(["StatusCallback", req.statusCallbackUrl], ["StatusCallbackEvent", "initiated ringing answered completed"]);
    }
    if (req.twimlUrl !== "") form.push(["Url", req.twimlUrl]);
    else form.push(["Twiml", `<Response><Say>Connecting your CRM call.</Say><Pause length="2"/></Response>`]);
    form.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${req.accountSid}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${req.accountSid}:${req.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    const raw = jsonObject(text);
    if (res.status >= 300) throw new Error(`twilio call failed (${res.status}): ${truncateBytes(text, 400)}`);
    const sid = str(raw?.sid);
    return { callSid: sid || `CA${randomUUID().replaceAll("-", "")}`, status: str(raw?.status), raw };
  }

  validateSignature(authToken: string, fullUrl: string, form: Form, signatureHeader: string): boolean {
    if (authToken === "") return false;
    const keys = [...form.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const data = fullUrl + keys.map((k) => k + formGet(form, k)).join("");
    const expected = createHmac("sha1", authToken).update(data).digest();
    const got = decodeStdBase64(signatureHeader);
    return got !== null && constantTimeEqual(expected, got);
  }

  parseStatusCallback(form: Form): CallStatusEvent {
    const sid = formGet(form, "CallSid");
    if (sid === "") throw new Error("missing CallSid");
    const status = formGet(form, "CallStatus");
    const d = formGet(form, "CallDuration");
    const raw: Json = {};
    for (const [k, vals] of form) if (vals.length > 0) raw[k] = vals[0];
    return {
      callSid: sid,
      accountSid: formGet(form, "AccountSid"),
      from: formGet(form, "From"),
      to: formGet(form, "To"),
      callStatus: status,
      direction: formGet(form, "Direction"),
      duration: goAtoi(d),
      recordingSid: formGet(form, "RecordingSid"),
      recordingUrl: formGet(form, "RecordingUrl"),
      timestamp: new Date(),
      eventKey: `twilio-call:${sid}:${status}`,
      raw,
    };
  }
}

/** Simulates calls without live Twilio credentials. */
export class DevTwilioProvider implements TwilioProvider {
  private readonly twilio = new TwilioVoiceProvider();

  placeCall(req: OutboundCallRequest): Promise<OutboundCallResult> {
    return Promise.resolve({
      callSid: `CA${randomUUID().replaceAll("-", "")}`,
      status: "queued",
      raw: { from: req.from, simulated: true, to: req.to },
    });
  }

  validateSignature(authToken: string, fullUrl: string, form: Form, signatureHeader: string): boolean {
    return authToken === "" || this.twilio.validateSignature(authToken, fullUrl, form, signatureHeader);
  }

  parseStatusCallback(form: Form): CallStatusEvent {
    return this.twilio.parseStatusCallback(form);
  }
}

export const formGet = (form: Form, key: string): string => form.get(key)?.[0] ?? "";

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Go's base64.StdEncoding.DecodeString (padding required; CR/LF ignored); null on error. */
function decodeStdBase64(s: string): Buffer | null {
  const clean = s.replace(/[\r\n]/g, "");
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  return Buffer.from(clean, "base64");
}

/** strconv.Atoi; null when s is not a base-10 integer. */
function goAtoi(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export function normalizePhone(v: string): string {
  return v.trim().replaceAll(" ", "").replaceAll("-", "");
}

export function digitsOnly(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

function parseUnix(s: string): Date {
  if (!/^[+-]?\d+$/.test(s)) return new Date();
  return new Date(Number(s) * 1000);
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : goV(v);
}

export function coalesce(a: string, b: string): string {
  return a.trim() !== "" ? a : b;
}
