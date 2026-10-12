import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCESS_COOKIE = "crm_access_token";
export const REFRESH_COOKIE = "crm_refresh_token";

/** Access-token payload; field names match the Go backend so tokens are interchangeable. */
export interface AccessClaims {
  uid: string;
  email: string;
  role: string;
  sub?: string;
  iss?: string;
  exp: number;
  iat?: number;
}

export class JwtService {
  constructor(private readonly secret: string) {}

  issueAccessToken(userId: string, email: string, roleCode: string): { token: string; expiresAt: Date } {
    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + ACCESS_TOKEN_TTL_MS / 1000;
    const token = jwt.sign(
      { uid: userId, email, role: roleCode, iss: "crm-api", sub: userId, exp, iat: nowSec },
      this.secret,
      { algorithm: "HS256", noTimestamp: true },
    );
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /** Throws when the token is malformed, expired or not HS256-signed with our secret. */
  parseAccessToken(token: string): AccessClaims {
    const decoded = jwt.verify(token, this.secret, { algorithms: ["HS256"] });
    if (typeof decoded === "string" || typeof decoded.uid !== "string") {
      throw new Error("invalid token");
    }
    return decoded as AccessClaims;
  }
}

/** 32 random bytes, base64url without padding, plus its SHA-256 hex hash (what the DB stores). */
export function newRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashRefreshToken(raw) };
}

export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** RFC 3339 with second precision, like Go's time.Format(time.RFC3339) for UTC times. */
export function formatRfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
