import { describe, expect, it } from "vitest";
import { buildRfc822, extractInlineImages, prepareOutboundPayload } from "../src/modules/email/mime.js";

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
    expect(raw).toContain("Content-Type: multipart/mixed;");
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
    expect(raw).not.toContain("multipart/related");
  });

  it("converts data-URI signature images to cid multipart/related parts", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const html = `<p>Thanks</p><div><img src="data:image/png;base64,${png.toString("base64")}" alt="Logo" /></div>`;
    const raw = buildRfc822("SE", "se@example.com", {
      toAddresses: ["me@example.com"],
      ccAddresses: [],
      bccAddresses: [],
      subject: "Follow up",
      bodyHtml: html,
      bodyText: "Thanks",
    });
    expect(raw).toContain("multipart/related");
    expect(raw).toContain('src="cid:crm-inline-');
    expect(raw).not.toContain("data:image/png");
    expect(raw).toContain("Content-Disposition: inline");
    expect(raw).toContain("Content-ID: <crm-inline-");
    expect(raw).toContain(png.toString("base64"));
  });
});

describe("extractInlineImages", () => {
  it("rewrites multiple data URIs and leaves remote src alone", () => {
    const a = Buffer.from("aaa").toString("base64");
    const b = Buffer.from("bbb").toString("base64");
    const { html, inline } = extractInlineImages(
      `<img src="data:image/jpeg;base64,${a}"><img src="https://x/y.png"><img src='data:image/png;base64,${b}'>`,
    );
    expect(inline).toHaveLength(2);
    expect(html).toContain('src="cid:');
    expect(html).toContain('src="https://x/y.png"');
    expect(html).not.toContain("data:image");
  });

  it("prepareOutboundPayload keeps file attachments after inline parts", () => {
    const png = Buffer.from("img").toString("base64");
    const out = prepareOutboundPayload(`<img src="data:image/png;base64,${png}">`, [
      { filename: "a.pdf", mimeType: "application/pdf", content: Buffer.from("pdf") },
    ]);
    expect(out.attachments).toHaveLength(2);
    expect(out.attachments[0]?.contentId).toBeTruthy();
    expect(out.attachments[1]?.filename).toBe("a.pdf");
  });
});
