/** Country, nationality, and phone required on Contacted → Negotiation. */

export function isNegotiationStage(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === "negotiation";
}

export const NEGOTIATION_PROFILE_FIELDS = ["country", "nationality", "phone"] as const;

export type NegotiationProfileField = (typeof NEGOTIATION_PROFILE_FIELDS)[number];

export function missingNegotiationProfileFields(lead: {
  country?: string | null;
  nationality?: string | null;
  phone?: string | null;
}): NegotiationProfileField[] {
  const missing: NegotiationProfileField[] = [];
  if (!(lead.country ?? "").trim()) missing.push("country");
  if (!(lead.nationality ?? "").trim()) missing.push("nationality");
  if (!(lead.phone ?? "").trim()) missing.push("phone");
  return missing;
}

export function negotiationProfileProblem(missing: readonly string[]): string | null {
  if (missing.length === 0) return null;
  if (missing.length === 3) return "Add country, nationality, and phone before moving to Negotiation";
  const labels: Record<string, string> = {
    country: "country",
    nationality: "nationality",
    phone: "phone number",
  };
  const listed = missing.map((k) => labels[k] ?? k);
  if (listed.length === 1) return `Add ${listed[0]} before moving to Negotiation`;
  return `Add ${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1]} before moving to Negotiation`;
}
