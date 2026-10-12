import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;
const BCRYPT_MAX_BYTES = 72;

/** Rejects passwords over 72 bytes like Go's bcrypt instead of silently truncating them. */
export function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, "utf8") > BCRYPT_MAX_BYTES) {
    return Promise.reject(new Error("bcrypt: password length exceeds 72 bytes"));
  }
  return bcrypt.hash(password, BCRYPT_COST);
}

/** Works with hashes written by the Go backend ($2a$). */
export function comparePassword(hash: string, password: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
