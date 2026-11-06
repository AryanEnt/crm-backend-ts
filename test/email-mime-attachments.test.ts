import { describe, expect, it } from "vitest";
import { buildRfc822 } from "../src/modules/email/mime.js";

describe("buildRfc822 attachments", () => {
  it("embeds base64 parts in a multipart message", () => {
    const raw = buildRfc822(
      "SE",
      "se@example.com",
      {
        toAddresses: ["client@example.com"],
        ccAddresses: [],
        bccAddresses: [],
        subject: "Your documents",
        bodyHtml: "<p>Hi</p>",
        bodyText: "Hi",
      },
      [{ filename: "visa.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4") }],
    );
    expect(raw).toContain('Content-Type: multipart/mixed;');
    expect(raw).toContain('filename="visa.pdf"');
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    expect(raw).toContain(Buffer.from("%PDF-1.4").toString("base64"));
  });

  it("keeps a simple body when there are no attachments", () => {
    const raw = buildRfc822("SE", "se@example.com", {
      toAddresses: ["client@example.com"],
      ccAddresses: [],
      bccAddresses: [],
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      bodyText: "Hi",
    });
    expect(raw).toContain("Content-Type: text/html");
    expect(raw).not.toContain("multipart/mixed");
  });
});
