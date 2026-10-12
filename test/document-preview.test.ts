import { describe, expect, it } from "vitest";
import { inlineContentType } from "../src/modules/documents/preview.js";

describe("inline document preview", () => {
  it("shows PDFs, images, text and media in the browser", () => {
    expect(inlineContentType("application/pdf", "a.pdf")).toBe("application/pdf");
    expect(inlineContentType("IMAGE/PNG", "a.png")).toBe("image/png");
    expect(inlineContentType("text/plain; charset=latin1", "notes.txt")).toBe("text/plain; charset=utf-8");
    expect(inlineContentType("video/mp4", "call.mp4")).toBe("video/mp4");
  });

  it("falls back to the extension when the upload had no usable type", () => {
    expect(inlineContentType("", "Passport.PDF")).toBe("application/pdf");
    expect(inlineContentType("application/octet-stream", "scan.jpeg")).toBe("image/jpeg");
    expect(inlineContentType("application/octet-stream", "report.docx")).toBeNull();
  });

  it("never shows types that can run scripts, whatever the file is called", () => {
    expect(inlineContentType("text/html", "page.html")).toBeNull();
    expect(inlineContentType("image/svg+xml", "logo.svg")).toBeNull();
    expect(inlineContentType("text/html", "looks-like.pdf")).toBeNull();
    expect(inlineContentType("application/octet-stream", "logo.svg")).toBeNull();
  });
});
