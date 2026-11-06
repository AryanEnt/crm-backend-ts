import { describe, expect, it } from "vitest";
import {
  contactRemarksProblem,
  isContactedStage,
  parseContactRating,
  validContactRemarks,
} from "../src/modules/leads/contact-rating.js";

describe("contact rating helpers", () => {
  it("recognises the Contacted stage case-insensitively", () => {
    expect(isContactedStage("Contacted")).toBe(true);
    expect(isContactedStage(" contacted ")).toBe(true);
    expect(isContactedStage("CONTACTED")).toBe(true);
    expect(isContactedStage("Negotiation")).toBe(false);
    expect(isContactedStage(null)).toBe(false);
  });

  it("accepts whole star ratings from 1 to 5", () => {
    expect(parseContactRating(1)).toBe(1);
    expect(parseContactRating(5)).toBe(5);
    expect(parseContactRating("3")).toBe(3);
    expect(parseContactRating(0)).toBeNull();
    expect(parseContactRating(6)).toBeNull();
    expect(parseContactRating(2.5)).toBeNull();
    expect(parseContactRating(null)).toBeNull();
    expect(parseContactRating("")).toBeNull();
  });

  it("requires at least five different words in remarks", () => {
    expect(validContactRemarks("")).toBe(false);
    expect(validContactRemarks("one two three four")).toBe(false);
    expect(validContactRemarks("good good good good good")).toBe(false);
    expect(validContactRemarks("spoke about budget timeline and next steps")).toBe(true);
    expect(contactRemarksProblem("")).toBe("Remarks are required");
    expect(contactRemarksProblem("one two")).toMatch(/at least 5 words/);
    expect(contactRemarksProblem("a a a a a")).toMatch(/different words/);
    expect(contactRemarksProblem("spoke about budget timeline and next steps")).toBeNull();
  });
});
