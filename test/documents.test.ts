import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AuditService } from "../src/modules/audit/audit.service.js";
import type { AutomationEmitter } from "../src/modules/automation/emitter.js";
import { DocumentsService } from "../src/modules/documents/documents.service.js";
import type { Store } from "../src/modules/storage/storage.js";
import type { TimelineService } from "../src/modules/timeline/timeline.service.js";
import { fakeDb } from "./helpers/fake-db.js";

const meta = { ip: "", userAgent: "" } as never;

function doc(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "passport.pdf",
    type: "passport",
    category: "identity",
    status: "uploaded",
    mimeType: "application/pdf",
    sizeBytes: 3,
    fileKey: "screenshots/leads/x/old.png",
    storageProvider: "r2",
    notes: "",
    rejectedReason: "",
    leadId: "22222222-2222-2222-2222-222222222222",
    leadName: "Asha Rai",
    customerId: null,
    customerName: null,
    dealId: null,
    dealTitle: null,
    uploadedBy: null,
    uploadedByName: null,
    verifiedBy: null,
    verifiedByName: null,
    requestedDate: null,
    uploadedDate: now,
    expiryDate: null,
    verifiedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("documents upload to existing", () => {
  it("skips old-file cleanup when the old provider's store is unavailable, like Go's storeFor error", async () => {
    const f = fakeDb();
    f.setRows([doc()]);
    const store: Store = {
      provider: () => "local",
      put: vi.fn(async (key: string) => ({ key, provider: "local", size: 3, contentType: "image/png" }) as never),
      open: vi.fn(),
      delete: vi.fn(async () => undefined),
      exists: vi.fn(async () => true),
    };
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const timeline = { record: vi.fn(async () => undefined) } as unknown as TimelineService;
    const hooks = { emit: vi.fn(async () => undefined) } as unknown as AutomationEmitter;
    const service = new DocumentsService(f.db, store, audit, timeline, hooks, null);

    const d = await service.uploadToExisting(
      "33333333-3333-3333-3333-333333333333",
      "11111111-1111-1111-1111-111111111111",
      { filename: "new.pdf", mimeType: "application/pdf", open: () => Readable.from(["abc"]) },
      meta,
    );

    expect(d.id).toBe("11111111-1111-1111-1111-111111111111");
    expect(store.delete).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      "33333333-3333-3333-3333-333333333333",
      "document.uploaded",
      "document",
      d.id,
      { name: d.name, type: d.type },
      meta,
    );
    expect(hooks.emit).toHaveBeenCalled();
  });
});
