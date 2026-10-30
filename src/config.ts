/** Environment configuration; the same variables the Go backend reads, plus GO_BACKEND_URL. */
export interface Config {
  appEnv: string;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  /** Primary origin (first FRONTEND_URL entry), used for redirects. */
  frontendUrl: string;
  /** Comma-separated CORS allowlist. */
  corsOrigins: string;
  storageRoot: string;
  storageDriver: string;
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Bucket: string;
  r2Endpoint: string;
  publicApiUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  gmailPubSubTopic: string;
  mailImapHost: string;
  mailImapPort: number;
  mailImapSecure: boolean;
  mailSmtpHost: string;
  mailSmtpPort: number;
  mailSmtpSecure: boolean;
  mailSyncIntervalMs: number;
  tokenEncryptionKey: string;
  /** Meta app for WhatsApp Embedded Signup (SE one-click connect). */
  metaAppId: string;
  metaAppSecret: string;
  /** Embedded Signup configuration ID from the Meta App Dashboard. */
  metaWhatsAppConfigId: string;
  /** Shared webhook verify token used for all connected WhatsApp numbers. */
  metaWhatsAppVerifyToken: string;
  metaGraphApiVersion: string;
  /** Go backend that still serves routes not yet ported. Empty disables forwarding. */
  goBackendUrl: string;
  /**
   * Run the automation worker in this process. Defaults to on only without GO_BACKEND_URL,
   * so it never runs alongside the Go backend's worker unless asked to.
   */
  automationWorker: boolean;
  /** Run the Gmail watch-renewal and scheduled-send worker. Same default as automationWorker. */
  emailWorker: boolean;
}

function env(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

export function primaryFrontendUrl(raw: string): string {
  for (const part of raw.split(",")) {
    const origin = part.trim().replace(/\/+$/, "");
    if (origin) return origin;
  }
  return "http://localhost:3000";
}

export function loadConfig(): Config {
  const frontendRaw = env("FRONTEND_URL", "http://localhost:3000");
  const jwtSecret = env("JWT_SECRET");
  // API_PORT wins over PORT (which Railway injects), as in the Go backend.
  const portRaw = env("API_PORT", env("PORT", "8080"));

  const missing: string[] = [];
  const databaseUrl = env("DATABASE_URL");
  if (!databaseUrl.trim()) missing.push("DATABASE_URL");
  if (!jwtSecret.trim()) missing.push("JWT_SECRET");
  if (missing.length > 0) {
    throw new Error(`missing required environment variables: ${missing.join(", ")}`);
  }

  const port = Number(portRaw);
  if (!/^[+-]?\d+$/.test(portRaw) || !Number.isSafeInteger(port)) {
    throw new Error(`API_PORT must be a valid port number: strconv.Atoi: parsing ${JSON.stringify(portRaw)}: invalid syntax`);
  }

  return {
    appEnv: env("APP_ENV", "development"),
    port,
    databaseUrl,
    jwtSecret,
    frontendUrl: primaryFrontendUrl(frontendRaw),
    corsOrigins: frontendRaw,
    storageRoot: env("STORAGE_ROOT", "./storage"),
    storageDriver: env("STORAGE_DRIVER", "local"),
    r2AccountId: env("R2_ACCOUNT_ID"),
    r2AccessKeyId: env("R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: env("R2_SECRET_ACCESS_KEY"),
    r2Bucket: env("R2_BUCKET"),
    r2Endpoint: env("R2_ENDPOINT"),
    publicApiUrl: env("PUBLIC_API_URL", "http://localhost:8080"),
    googleClientId: env("GOOGLE_CLIENT_ID"),
    googleClientSecret: env("GOOGLE_CLIENT_SECRET"),
    gmailPubSubTopic: env("GMAIL_PUBSUB_TOPIC"),
    mailImapHost: env("MAIL_IMAP_HOST", "mail.entegrasources.com.np"),
    mailImapPort: Number(env("MAIL_IMAP_PORT", "993")) || 993,
    mailImapSecure: parseFlag("MAIL_IMAP_SECURE", true),
    mailSmtpHost: env("MAIL_SMTP_HOST", env("MAIL_IMAP_HOST", "mail.entegrasources.com.np")),
    mailSmtpPort: Number(env("MAIL_SMTP_PORT", "587")) || 587,
    mailSmtpSecure: parseFlag("MAIL_SMTP_SECURE", false),
    mailSyncIntervalMs: Number(env("MAIL_SYNC_INTERVAL_MS", "300000")) || 300_000,
    tokenEncryptionKey: env("TOKEN_ENCRYPTION_KEY", jwtSecret),
    metaAppId: env("META_APP_ID"),
    metaAppSecret: env("META_APP_SECRET"),
    metaWhatsAppConfigId: env("META_WHATSAPP_CONFIG_ID"),
    metaWhatsAppVerifyToken: env("META_WHATSAPP_VERIFY_TOKEN"),
    metaGraphApiVersion: env("META_GRAPH_API_VERSION", "v21.0"),
    goBackendUrl: env("GO_BACKEND_URL").replace(/\/+$/, ""),
    automationWorker: parseFlag("AUTOMATION_WORKER", env("GO_BACKEND_URL") === ""),
    emailWorker: parseFlag("EMAIL_WORKER", env("GO_BACKEND_URL") === ""),
  };
}

function parseFlag(key: string, fallback: boolean): boolean {
  const v = env(key).trim().toLowerCase();
  if (v === "") return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${key} must be true or false, got "${env(key)}"`);
}

export function isDevelopment(cfg: Pick<Config, "appEnv">): boolean {
  const e = cfg.appEnv.toLowerCase();
  return e === "development" || e === "dev";
}
