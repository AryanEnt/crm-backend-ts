import { createHash } from "node:crypto";
import {
  parsePhoneNumberFromString,
  type CountryCode,
  type PhoneNumber,
} from "libphonenumber-js";

/** Suggested statuses from the phone-validation feature. */
export const PHONE_VALIDATION_STATUSES = [
  "pending",
  "valid",
  "invalid",
  "duplicate",
  "invalid_duplicate",
  "needs_review",
] as const;

export type PhoneValidationStatus = (typeof PHONE_VALIDATION_STATUSES)[number];

export const PHONE_ISSUE_STATUSES: ReadonlySet<PhoneValidationStatus> = new Set([
  "invalid",
  "duplicate",
  "invalid_duplicate",
  "needs_review",
]);

/** Country display name (CRM `leads.country`) → ISO 3166-1 alpha-2 for libphonenumber. */
const COUNTRY_NAME_TO_ISO: Record<string, CountryCode> = {
  australia: "AU",
  "new zealand": "NZ",
  nepal: "NP",
  india: "IN",
  philippines: "PH",
  "sri lanka": "LK",
  bangladesh: "BD",
  pakistan: "PK",
  china: "CN",
  vietnam: "VN",
  indonesia: "ID",
  malaysia: "MY",
  singapore: "SG",
  fiji: "FJ",
  "united arab emirates": "AE",
  uae: "AE",
  "united kingdom": "GB",
  uk: "GB",
  "united states": "US",
  usa: "US",
  canada: "CA",
  "south africa": "ZA",
};

export type PhoneParseKind = "empty" | "valid" | "invalid" | "needs_review";

export interface PhoneParseResult {
  kind: PhoneParseKind;
  /** E.164 when kind is valid. */
  e164: string | null;
  /** Digit-only form for fuzzy duplicate checks when E.164 is unavailable. */
  digits: string;
  message: string;
  countryUsed: string;
}

export function phoneInputHash(phone: string | null | undefined, phoneCountryCode: string, country: string): string {
  return createHash("sha256")
    .update(`${(phone ?? "").trim()}\0${phoneCountryCode.trim().toUpperCase()}\0${country.trim()}`, "utf8")
    .digest("hex");
}

export function resolveDefaultCountry(phoneCountryCode: string, countryName: string): CountryCode | undefined {
  const code = phoneCountryCode.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code as CountryCode;
  const mapped = COUNTRY_NAME_TO_ISO[countryName.trim().toLowerCase()];
  return mapped;
}

export function phoneDigitsOnly(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

/**
 * Syntactic phone check. Does not contact carriers or WhatsApp.
 * Empty input is not invalid — callers treat it as cleared/optional.
 */
export function parseLeadPhone(
  raw: string | null | undefined,
  phoneCountryCode: string,
  countryName: string,
): PhoneParseResult {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    return { kind: "empty", e164: null, digits: "", message: "", countryUsed: "" };
  }

  const digits = phoneDigitsOnly(trimmed);
  const defaultCountry = resolveDefaultCountry(phoneCountryCode, countryName);

  let parsed: PhoneNumber | undefined;
  try {
    parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  } catch {
    parsed = undefined;
  }

  if (!parsed) {
    if (!defaultCountry && !trimmed.startsWith("+")) {
      return {
        kind: "needs_review",
        e164: null,
        digits,
        message: "Country calling code is unclear; phone number needs review",
        countryUsed: "",
      };
    }
    return {
      kind: "invalid",
      e164: null,
      digits,
      message: "Phone number format is invalid",
      countryUsed: defaultCountry ?? "",
    };
  }

  if (!parsed.isPossible()) {
    // Possible() false with a known country → usually wrong length; still flag invalid.
    // When country was guessed poorly, prefer needs_review.
    if (!defaultCountry && !trimmed.startsWith("+")) {
      return {
        kind: "needs_review",
        e164: null,
        digits,
        message: "Not enough country information to validate this number",
        countryUsed: parsed.country ?? "",
      };
    }
    return {
      kind: "invalid",
      e164: null,
      digits,
      message: "Phone number format is invalid",
      countryUsed: parsed.country ?? defaultCountry ?? "",
    };
  }

  if (!parsed.isValid()) {
    // Possible but not valid — keep as needs_review rather than hard-invalid when borderline.
    return {
      kind: "needs_review",
      e164: null,
      digits,
      message: "Phone number could not be confirmed; needs review",
      countryUsed: parsed.country ?? defaultCountry ?? "",
    };
  }

  return {
    kind: "valid",
    e164: parsed.format("E.164"),
    digits: phoneDigitsOnly(parsed.format("E.164")),
    message: "",
    countryUsed: parsed.country ?? defaultCountry ?? "",
  };
}

/** Combine format result with whether normalized/digit duplicates exist. */
export function combinePhoneStatus(
  format: PhoneParseKind,
  hasDuplicate: boolean,
): { status: PhoneValidationStatus; message: string } {
  if (format === "empty") {
    return { status: "valid", message: "" };
  }
  if (format === "valid" && !hasDuplicate) {
    return { status: "valid", message: "" };
  }
  if (format === "valid" && hasDuplicate) {
    return {
      status: "duplicate",
      message: "This number is also used by another lead",
    };
  }
  if (format === "invalid" && hasDuplicate) {
    return {
      status: "invalid_duplicate",
      message: "Phone number format is invalid and matches another lead",
    };
  }
  if (format === "invalid") {
    return { status: "invalid", message: "Phone number format is invalid" };
  }
  if (format === "needs_review" && hasDuplicate) {
    return {
      status: "invalid_duplicate",
      message: "Phone number needs review and matches another lead",
    };
  }
  return {
    status: "needs_review",
    message: "Country or number information is insufficient for reliable validation",
  };
}

export const PHONE_NOTIFICATION_TYPE = "lead_phone_issue";

export function phoneIssueDedupeKey(leadId: string, windowStartMs: number): string {
  const day = Math.floor(windowStartMs / (24 * 60 * 60 * 1000));
  return `lead_phone_issue:${leadId}:${day}`;
}

export function phoneIssueCopy(leadName: string): { title: string; body: string } {
  const name = leadName.trim() || "Untitled";
  return {
    title: "Lead Phone Number Needs Attention",
    body: `The contact number for lead "${name}" is invalid or already associated with another lead. Please update the phone number to resolve this issue.`,
  };
}
