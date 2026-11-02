import { promises as dns } from "node:dns";
import type { ImapProviderKind } from "./imap-presets.js";

export type MxRecord = { exchange: string; priority?: number };

/** Public mail hosts that identify a provider. Matched against the domain's MX records. */
const MX_PROVIDERS: readonly [suffix: string, provider: Exclude<ImapProviderKind, "imap">][] = [
  ["migadu.com", "migadu"],
  ["spacemail.com", "spacemail"],
];

/**
 * Which preset hosts a domain, from its MX records (lowest priority first).
 * "aspmx1.migadu.com." → "migadu". A domain on its own server returns null.
 */
export function providerFromMx(records: readonly MxRecord[]): Exclude<ImapProviderKind, "imap"> | null {
  const host = primaryMxHost(records);
  if (!host) return null;
  for (const [suffix, provider] of MX_PROVIDERS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return provider;
  }
  return null;
}

/** Lowest-priority MX host, without a trailing dot. */
export function primaryMxHost(records: readonly MxRecord[]): string {
  const ordered = [...records].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  for (const record of ordered) {
    const host = record.exchange.trim().toLowerCase().replace(/\.$/, "");
    if (host) return host;
  }
  return "";
}

/** True when the domain receives mail on itself or on one of its own hostnames. */
export function isSelfHostedMx(domain: string, records: readonly MxRecord[]): boolean {
  return hostServesDomain(primaryMxHost(records), domain);
}

/** "mail.example.com" serves "example.com"; "mx1.spacemail.com" does not. */
export function hostServesDomain(host: string, domain: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  return h !== "" && d !== "" && (h === d || h.endsWith(`.${d}`));
}

/** MX lookup that never throws: a missing or slow domain is "not detectable". */
export async function lookupMx(domain: string): Promise<MxRecord[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dns.resolveMx(domain),
      new Promise<MxRecord[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error("mx lookup timed out")), 4_000);
      }),
    ]);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
