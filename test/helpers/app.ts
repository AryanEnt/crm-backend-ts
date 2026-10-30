import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { JwtService } from "../../src/modules/auth/tokens.js";
import type { FakeDb } from "./fake-db.js";

export const SECRET = "test-secret-key-at-least-32-chars!!";
export const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

export function config(overrides: Partial<Config> = {}): Config {
  return {
    appEnv: "development",
    port: 0,
    databaseUrl: "postgres://unused",
    jwtSecret: SECRET,
    frontendUrl: "http://localhost:3000",
    corsOrigins: "http://localhost:3000,http://10.0.0.5:3000",
    storageRoot: join(tmpdir(), "crm-backend-ts-test-storage"),
    storageDriver: "local",
    r2AccountId: "",
    r2AccessKeyId: "",
    r2SecretAccessKey: "",
    r2Bucket: "",
    r2Endpoint: "",
    publicApiUrl: "http://localhost:8081",
    googleClientId: "",
    googleClientSecret: "",
    gmailPubSubTopic: "",
    mailImapHost: "mail.entegrasources.com.np",
    mailImapPort: 993,
    mailImapSecure: true,
    mailSmtpHost: "mail.entegrasources.com.np",
    mailSmtpPort: 587,
    mailSmtpSecure: false,
    mailSyncIntervalMs: 300_000,
    tokenEncryptionKey: SECRET,
    metaAppId: "",
    metaAppSecret: "",
    metaWhatsAppConfigId: "",
    metaWhatsAppVerifyToken: "",
    metaGraphApiVersion: "v21.0",
    goBackendUrl: "",
    automationWorker: false,
    emailWorker: false,
    ...overrides,
  };
}

export function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: "admin@crm.local",
    passwordHash: "",
    fullName: "Super Admin",
    phone: "",
    roleId: "11111111-1111-1111-1111-111111111111",
    roleCode: "super_admin",
    roleName: "Super Admin",
    isActive: true,
    timezone: "",
    ...overrides,
  };
}

export function bearer(): string {
  return `Bearer ${new JwtService(SECRET).issueAccessToken(USER_ID, "admin@crm.local", "super_admin").token}`;
}

/** Queues the four queries the authenticate middleware runs, granting the given permissions. */
export function queueAuth(f: FakeDb, ...permissions: string[]): void {
  f.queue(
    [userRow()],
    permissions.map((code) => ({ code, scope: "organization" })),
    [],
    [],
  );
}
