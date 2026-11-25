import { describe, expect, it } from "vitest";
import {
  isNegotiationStage,
  missingNegotiationProfileFields,
  negotiationProfileProblem,
} from "../src/modules/leads/negotiation-profile.js";

describe("negotiation profile helpers", () => {
  it("recognises the Negotiation stage case-insensitively", () => {
    expect(isNegotiationStage("Negotiation")).toBe(true);
    expect(isNegotiationStage(" negotiation ")).toBe(true);
    expect(isNegotiationStage("NEGOTIATION")).toBe(true);
    expect(isNegotiationStage("Contacted")).toBe(false);
    expect(isNegotiationStage(null)).toBe(false);
  });

  it("lists only the blank country, nationality, and phone fields", () => {
    expect(missingNegotiationProfileFields({ country: "Australia", nationality: "Nepali", phone: "0400" })).toEqual([]);
    expect(missingNegotiationProfileFields({ country: "  ", nationality: "", phone: null })).toEqual([
      "country",
      "nationality",
      "phone",
    ]);
    expect(missingNegotiationProfileFields({ country: "Australia", nationality: "  ", phone: "0412 345 678" })).toEqual([
      "nationality",
    ]);
  });

  it("names the missing fields in the error message", () => {
    expect(negotiationProfileProblem([])).toBeNull();
    expect(negotiationProfileProblem(["phone"])).toMatch(/phone number/);
    expect(negotiationProfileProblem(["country", "nationality"])).toMatch(/country and nationality/);
    expect(negotiationProfileProblem(["country", "nationality", "phone"])).toMatch(/country, nationality, and phone/);
  });
});
