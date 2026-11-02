import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "../../lib/app-error.js";

export type MailHostPolicy = {
  allowPrivate: boolean;
  allowlist: string[];
};

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => Number(x));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((n[0]! << 24) | (n[1]! << 16) | (n[2]! << 8) | n[3]!) >>> 0;
}

function inCidrV4(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split("/");
  const ipN = ipv4ToInt(ip);
  const netN = net ? ipv4ToInt(net) : null;
  const bits = Number(bitsRaw);
  if (ipN === null || netN === null || !Number.isInteger(bits)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipN & mask) === (netN & mask);
}

function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    return (
      inCidrV4(v4, "10.0.0.0/8") ||
      inCidrV4(v4, "127.0.0.0/8") ||
      inCidrV4(v4, "169.254.0.0/16") ||
      inCidrV4(v4, "172.16.0.0/12") ||
      inCidrV4(v4, "192.168.0.0/16") ||
      inCidrV4(v4, "0.0.0.0/8")
    );
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

/** Blocks localhost/private targets unless the deployment explicitly allows them. */
export async function assertMailHostAllowed(host: string, policy: MailHostPolicy): Promise<void> {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) throw AppError.validation("Mail server hostname is required");
  if (h.includes("/") || h.includes(" ") || h.includes("@")) {
    throw AppError.validation("Mail server hostname is not valid");
  }
  if (policy.allowlist.length > 0 && !policy.allowlist.includes(h)) {
    throw AppError.validation("That mail server is not on the allowed host list");
  }
  if (!policy.allowPrivate && (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal"))) {
    throw AppError.validation("That mail host is not allowed");
  }
  let address = h;
  if (!isIP(h)) {
    try {
      address = (await lookup(h)).address;
    } catch {
      throw AppError.validation("Could not resolve the mail server hostname");
    }
  }
  if (!policy.allowPrivate && isPrivateAddress(address)) {
    throw AppError.validation("That mail host is not allowed");
  }
}

export function parseHostAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
