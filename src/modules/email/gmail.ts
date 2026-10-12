const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const USER_INFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const HTTP_TIMEOUT_MS = 30_000;

const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface GoogleProfile {
  email: string;
  name: string;
  picture: string;
}

export interface GmailProfile {
  emailAddress: string;
  historyId: number;
}

export interface GmailWatchResponse {
  historyId: number;
  expiration: string;
}

export interface GmailSendResponse {
  id: string;
  threadId: string;
}

export interface GmailHistoryResponse {
  history: { messagesAdded: { message: { id: string } }[] }[];
  historyId: number;
}

export interface GmailPayload {
  mimeType: string;
  filename: string;
  headers: { name: string; value: string }[];
  body: { size: number; data: string; attachmentId: string };
  parts: GmailPayload[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: string;
  payload: GmailPayload;
}

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  providerId: string;
}

export interface GoogleErrorDetails {
  code?: number;
  status?: string;
  message?: string;
  reasons: string[];
}

/** Provider HTTP failure with only sanitized diagnostics retained. */
export class GoogleApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly googleError: GoogleErrorDetails,
    readonly revoked: boolean,
  ) {
    super(`google ${operation} failed with HTTP ${status}`);
    this.name = "GoogleApiError";
  }
}

/** Gmail API error response; revoked when the grant is no longer usable. */
export class GmailApiError extends GoogleApiError {
  constructor(operation: string, status: number, googleError: GoogleErrorDetails, revoked: boolean) {
    super(operation, status, googleError, revoked);
    this.name = "GmailApiError";
  }
}

function sanitizeGoogleText(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:ya29|1\/\/|4\/|GOCSPX-)[A-Za-z0-9._~-]+/g, "[REDACTED]")
    .replace(/("(?:access_token|refresh_token|client_secret|authorization_code|code)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/\b(access_token|refresh_token|client_secret|authorization_code|code)\s*[:=]\s*[^\s&,;]+/gi, "$1=[REDACTED]")
    .slice(0, 300);
}

function googleErrorDetails(body: string): GoogleErrorDetails {
  let root: unknown;
  try {
    root = JSON.parse(body) as unknown;
  } catch {
    return { reasons: [] };
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) return { reasons: [] };
  const rootObj = root as Record<string, unknown>;
  const nested = rootObj.error;
  const error =
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : rootObj;
  const details: GoogleErrorDetails = { reasons: [] };
  if (typeof error.code === "number" && Number.isInteger(error.code)) details.code = error.code;
  if (typeof error.status === "string") details.status = sanitizeGoogleText(error.status);
  const message = typeof error.message === "string" ? error.message : rootObj.error_description;
  if (typeof message === "string") details.message = sanitizeGoogleText(message);

  const reasons: string[] = [];
  if (typeof rootObj.error === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(rootObj.error)) reasons.push(rootObj.error);
  for (const collection of [error.errors, error.details]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const reason = (item as Record<string, unknown>).reason;
        if (typeof reason === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(reason)) reasons.push(reason);
      }
    }
  }
  details.reasons = [...new Set(reasons)].slice(0, 8);
  return details;
}

function sanitizedFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return sanitizeGoogleText(message);
}

export function googleErrorLogFields(err: unknown, fallbackOperation: string): {
  operation: string;
  httpStatus: number | null;
  googleError?: GoogleErrorDetails;
  failure?: string;
} {
  if (err instanceof GoogleApiError) {
    return {
      operation: err.operation,
      httpStatus: err.status,
      googleError: err.googleError,
    };
  }
  return {
    operation: fallbackOperation,
    httpStatus: null,
    failure: sanitizedFailure(err),
  };
}

// ------------------------------------------------ strict decoding, like json.Unmarshal into typed structs

type Obj = Record<string, unknown>;

class DecodeError extends Error {
  constructor(field: string, want: string) {
    super(`json: cannot unmarshal into Go struct field ${field} of type ${want}`);
  }
}

/** Go matches JSON keys to struct fields case-insensitively, preferring an exact match. */
function field(o: Obj, name: string): unknown {
  if (name in o) return o[name];
  const lower = name.toLowerCase();
  const key = Object.keys(o).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : o[key];
}

function obj(v: unknown, name: string): Obj {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new DecodeError(name, "struct");
  return v as Obj;
}

function strField(o: Obj, name: string): string {
  const v = field(o, name);
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new DecodeError(name, "string");
  return v;
}

function intField(o: Obj, name: string): number {
  const v = field(o, name);
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new DecodeError(name, "int");
  return v;
}

/** Gmail's uint64 fields arrive as JSON strings; numbers are accepted too. */
function uint64Field(o: Obj, name: string): number {
  const v = field(o, name);
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  throw new DecodeError(name, "uint64");
}

function arrField(o: Obj, name: string): unknown[] {
  const v = field(o, name);
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new DecodeError(name, "slice");
  return v;
}

function decodePayload(v: unknown): GmailPayload {
  const p = obj(v, "payload");
  const body = obj(field(p, "body"), "body");
  return {
    mimeType: strField(p, "mimeType"),
    filename: strField(p, "filename"),
    headers: arrField(p, "headers").map((h) => {
      const o = obj(h, "headers");
      return { name: strField(o, "name"), value: strField(o, "value") };
    }),
    body: { size: intField(body, "size"), data: strField(body, "data"), attachmentId: strField(body, "attachmentId") },
    parts: arrField(p, "parts").map(decodePayload),
  };
}

function parseJsonObject(text: string): Obj {
  return obj(JSON.parse(text) as unknown, "response");
}

/** Go's url.QueryEscape. */
export function goQueryEscape(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** Go's url.Values.Encode: keys sorted, values query-escaped. */
export function goEncodeValues(values: Record<string, string>): string {
  return Object.keys(values)
    .sort()
    .map((k) => `${goQueryEscape(k)}=${goQueryEscape(values[k]!)}`)
    .join("&");
}

/** Go's url.PathEscape for a single path segment. */
function goPathEscape(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export class GmailClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirect: string,
  ) {}

  authUrl(state: string): string {
    return `${GOOGLE_AUTH_URL}?${goEncodeValues({
      client_id: this.clientId,
      redirect_uri: this.redirect,
      response_type: "code",
      scope: OAUTH_SCOPES,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    })}`;
  }

  exchangeCode(code: string): Promise<GoogleTokens> {
    return this.tokenRequest({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirect,
      grant_type: "authorization_code",
    }, "oauth.token.exchange");
  }

  refresh(refreshToken: string): Promise<GoogleTokens> {
    return this.tokenRequest({
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token",
    }, "oauth.token.refresh");
  }

  private async tokenRequest(form: Record<string, string>, operation: string): Promise<GoogleTokens> {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: goEncodeValues(form),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const body = await res.text().catch(() => "");
    if (res.status >= 400) {
      const details = googleErrorDetails(body);
      throw new GoogleApiError(operation, res.status, details, details.reasons.includes("invalid_grant"));
    }
    const o = parseJsonObject(body);
    return {
      accessToken: strField(o, "access_token"),
      refreshToken: strField(o, "refresh_token"),
      expiresIn: intField(o, "expires_in"),
    };
  }

  async userInfo(accessToken: string): Promise<GoogleProfile> {
    const o = await this.getJson(accessToken, USER_INFO_URL);
    return { email: strField(o, "email"), name: strField(o, "name"), picture: strField(o, "picture") };
  }

  async gmailProfile(accessToken: string): Promise<GmailProfile> {
    const o = await this.getJson(accessToken, `${GMAIL_API_BASE}/profile`);
    return { emailAddress: strField(o, "emailAddress"), historyId: uint64Field(o, "historyId") };
  }

  async watch(accessToken: string, topic: string): Promise<GmailWatchResponse> {
    const o = await this.postJson(accessToken, `${GMAIL_API_BASE}/watch`, { topicName: topic, labelIds: ["INBOX"] });
    return { historyId: uint64Field(o, "historyId"), expiration: strField(o, "expiration") };
  }

  async stopWatch(accessToken: string): Promise<void> {
    await this.postJson(accessToken, `${GMAIL_API_BASE}/stop`, {}).catch(() => undefined);
  }

  async send(accessToken: string, rawRfc822: string, threadId: string): Promise<GmailSendResponse> {
    const body: Obj = { raw: Buffer.from(rawRfc822).toString("base64url") };
    if (threadId !== "") body.threadId = threadId;
    const o = await this.postJson(accessToken, `${GMAIL_API_BASE}/messages/send`, body);
    return { id: strField(o, "id"), threadId: strField(o, "threadId") };
  }

  async getMessage(accessToken: string, id: string): Promise<GmailMessage> {
    const o = await this.getJson(accessToken, `${GMAIL_API_BASE}/messages/${goPathEscape(id)}?format=full`);
    return {
      id: strField(o, "id"),
      threadId: strField(o, "threadId"),
      snippet: strField(o, "snippet"),
      internalDate: strField(o, "internalDate"),
      payload: decodePayload(field(o, "payload")),
    };
  }

  async history(accessToken: string, startHistoryId: string): Promise<GmailHistoryResponse> {
    const o = await this.getJson(
      accessToken,
      `${GMAIL_API_BASE}/history?startHistoryId=${goQueryEscape(startHistoryId)}&historyTypes=messageAdded`,
    );
    return {
      history: arrField(o, "history").map((h) => ({
        messagesAdded: arrField(obj(h, "history"), "messagesAdded").map((a) => ({
          message: { id: strField(obj(field(obj(a, "messagesAdded"), "message"), "message"), "id") },
        })),
      })),
      historyId: uint64Field(o, "historyId"),
    };
  }

  async listRecent(accessToken: string, max: number): Promise<string[]> {
    const o = await this.getJson(accessToken, `${GMAIL_API_BASE}/messages?maxResults=${max <= 0 ? 50 : max}&labelIds=INBOX`);
    return arrField(o, "messages").map((m) => strField(obj(m, "messages"), "id"));
  }

  private getJson(token: string, url: string): Promise<Obj> {
    return this.doJson(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  }

  private postJson(token: string, url: string, payload: Obj): Promise<Obj> {
    return this.doJson(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  private async doJson(url: string, init: RequestInit): Promise<Obj> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const body = await res.text().catch(() => "");
    if (res.status >= 400) {
      const details = googleErrorDetails(body);
      const method = init.method ?? "GET";
      const pathname = new URL(url).pathname.replace(/\/messages\/[^/]+$/, "/messages/:id");
      const operation = `${method} ${pathname}`;
      const revoked = res.status === 401 || details.reasons.includes("invalid_grant");
      if (pathname.startsWith("/gmail/v1/users/me/")) throw new GmailApiError(operation, res.status, details, revoked);
      throw new GoogleApiError(operation, res.status, details, revoked);
    }
    if (body.length === 0) return {};
    return parseJsonObject(body);
  }
}

/** URL-safe base64, padded or not; "" when undecodable. */
export function decodeGmailBody(data: string): string {
  if (data === "") return "";
  const clean = data.replace(/[\r\n]/g, "");
  const padded = clean.length % 4 === 0 && /^[A-Za-z0-9_-]*(?:={1,2})?$/.test(clean);
  const raw = clean.length % 4 !== 1 && /^[A-Za-z0-9_-]*$/.test(clean);
  if (!padded && !raw) return "";
  return Buffer.from(clean, "base64url").toString();
}

export function headerValue(headers: GmailPayload["headers"], name: string): string {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

export function collectBodies(p: GmailPayload): { html: string; text: string; attachments: ParsedAttachment[] } {
  const ct = p.mimeType.toLowerCase();
  let html = ct.startsWith("text/html") && p.body.data !== "" ? decodeGmailBody(p.body.data) : "";
  let text = ct.startsWith("text/plain") && p.body.data !== "" ? decodeGmailBody(p.body.data) : "";
  const attachments: ParsedAttachment[] = [];
  if (p.filename !== "" && p.body.attachmentId !== "") {
    attachments.push({ filename: p.filename, mimeType: p.mimeType, size: p.body.size, providerId: p.body.attachmentId });
  }
  for (const part of p.parts) {
    const sub = collectBodies(part);
    if (html === "") html = sub.html;
    if (text === "") text = sub.text;
    attachments.push(...sub.attachments);
  }
  return { html, text, attachments };
}
