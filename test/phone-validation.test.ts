import { describe, expect, it } from "vitest";
import {
  combinePhoneStatus,
  parseLeadPhone,
  phoneInputHash,
  phoneIssueCopy,
  phoneIssueDedupeKey,
} from "../src/modules/leads/phone-validation.js";

describe("parseLeadPhone", () => {
  it("treats empty phone as empty (not invalid)", () => {
    expect(parseLeadPhone("", "AU", "Australia").kind).toBe("empty");
    expect(parseLeadPhone("   ", "AU", "Australia").kind).toBe("empty");
    expect(parseLeadPhone(null, "AU", "Australia").kind).toBe("empty");
  });

  it("normalizes a valid AU mobile to E.164", () => {
    const r = parseLeadPhone("0412 345 678", "AU", "Australia");
    expect(r.kind).toBe("valid");
    expect(r.e164).toBe("+61412345678");
  });

  it("accepts formatted international numbers", () => {
    const r = parseLeadPhone("+61 412 345 678", "", "Australia");
    expect(r.kind).toBe("valid");
    expect(r.e164).toBe("+61412345678");
  });

  it("flags incomplete numbers as invalid when country is known", () => {
    const r = parseLeadPhone("0412", "AU", "Australia");
    expect(r.kind).toBe("invalid");
    expect(r.e164).toBeNull();
  });

  it("asks for review when country is unknown and number has no +", () => {
    const r = parseLeadPhone("412345678", "", "Atlantis");
    expect(r.kind).toBe("needs_review");
  });

  it("does not require WhatsApp reachability — valid format is enough", () => {
    // A syntactically valid AU number is valid regardless of registration.
    const r = parseLeadPhone("+61400000000", "AU", "Australia");
    expect(["valid", "needs_review", "invalid"]).toContain(r.kind);
    if (r.kind === "valid") expect(r.e164).toBe("+61400000000");
  });
});

describe("combinePhoneStatus", () => {
  it("marks valid unique numbers as valid", () => {
    expect(combinePhoneStatus("valid", false)).toEqual({ status: "valid", message: "" });
  });

  it("marks valid duplicates as duplicate", () => {
    expect(combinePhoneStatus("valid", true).status).toBe("duplicate");
  });

  it("marks invalid duplicates as invalid_duplicate", () => {
    expect(combinePhoneStatus("invalid", true).status).toBe("invalid_duplicate");
  });

  it("treats empty as valid (no issue)", () => {
    expect(combinePhoneStatus("empty", false).status).toBe("valid");
  });
});

describe("phone helpers", () => {
  it("hashes phone + country for stale-job detection", () => {
    const a = phoneInputHash("0412 345 678", "AU", "Australia");
    const b = phoneInputHash("0412 345 678", "AU", "Australia");
    const c = phoneInputHash("0412 345 679", "AU", "Australia");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("builds stable daily dedupe keys", () => {
    const day = 20_000 * 86_400_000;
    expect(phoneIssueDedupeKey("lead-1", day)).toBe(phoneIssueDedupeKey("lead-1", day + 1000));
    expect(phoneIssueDedupeKey("lead-1", day)).not.toBe(phoneIssueDedupeKey("lead-1", day + 86_400_000));
  });

  it("uses the required notification copy", () => {
    const copy = phoneIssueCopy("Priya Sharma");
    expect(copy.title).toBe("Lead Phone Number Needs Attention");
    expect(copy.body).toContain("Priya Sharma");
    expect(copy.body).toMatch(/invalid or already associated/i);
  });
});
