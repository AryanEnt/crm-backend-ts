import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const NONCE_SIZE = 12;
const TAG_SIZE = 16;

/** Go's base64.StdEncoding.DecodeString: strict alphabet and padding; \r and \n are ignored. */
export function decodeStdBase64(s: string): Buffer | null {
  const clean = s.replace(/[\r\n]/g, "");
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*(?:={1,2})?$/.test(clean)) return null;
  return Buffer.from(clean, "base64");
}

/**
 * Encrypts OAuth tokens at rest with AES-256-GCM, byte-compatible with the Go TokenBox:
 * base64(nonce || ciphertext || tag) under sha256(trimmed secret).
 */
export class TokenBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret.trim()).digest();
  }

  encrypt(plain: string): string {
    if (plain === "") return "";
    const nonce = randomBytes(NONCE_SIZE);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const sealed = Buffer.concat([nonce, cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return sealed.toString("base64");
  }

  decrypt(encoded: string): string {
    if (encoded.trim() === "") return "";
    const raw = decodeStdBase64(encoded);
    if (raw === null) throw new Error("illegal base64 data");
    if (raw.length < NONCE_SIZE) throw new Error("ciphertext too short");
    if (raw.length < NONCE_SIZE + TAG_SIZE) throw new Error("cipher: message authentication failed");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, NONCE_SIZE));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_SIZE));
    try {
      return Buffer.concat([decipher.update(raw.subarray(NONCE_SIZE, raw.length - TAG_SIZE)), decipher.final()]).toString();
    } catch {
      throw new Error("cipher: message authentication failed");
    }
  }
}
