import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/database.js";
import { CommunicationsRepository } from "../src/modules/communications/communications.service.js";
import { EmailRepository } from "../src/modules/email/email.repository.js";
import { fakeDb } from "./helpers/fake-db.js";

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

describe("email address matching is lead-only", () => {
  it("one address with several leads (repeat purchases) matches its best lead", async () => {
    const f = fakeDb();
    f.queue([
      { id: "open-lead", name: "Asha", email: "asha@x.test" },
      { id: "won-lead", name: "Asha", email: "asha@x.test" },
    ]);
    const m = await new EmailRepository(f.db as unknown as Database).matchAddresses([" Asha@X.test "]);
    expect(m).toMatchObject({ leadId: "open-lead", leadName: "Asha", customerId: null, count: 1 });
    expect(f.queries).toHaveLength(1);
    expect(flat(f.queries[0]!.sql)).toContain("FROM leads");
    expect(flat(f.queries[0]!.sql)).toContain("ORDER BY (status IN ('open','inbox','qualified')) DESC");
    expect(f.queries[0]!.parameters[0]).toEqual(["asha@x.test"]);
  });

  it("two different matching addresses are ambiguous", async () => {
    const f = fakeDb();
    f.queue([
      { id: "a", name: "A", email: "a@x.test" },
      { id: "b", name: "B", email: "b@x.test" },
    ]);
    const m = await new EmailRepository(f.db as unknown as Database).matchAddresses(["a@x.test", "b@x.test"]);
    expect(m).toMatchObject({ leadId: null, count: 2 });
  });

  it("no addresses means no query", async () => {
    const f = fakeDb();
    expect((await new EmailRepository(f.db as unknown as Database).matchAddresses([" "])).count).toBe(0);
    expect(f.queries).toHaveLength(0);
  });
});

describe("phone matching prefers leads", () => {
  it("returns the lead without looking at customers", async () => {
    const f = fakeDb();
    f.queue([{ id: "lead-1" }]);
    const ctx = await new CommunicationsRepository(f.db as unknown as Database).resolvePhoneContext("+61 400 111 222");
    expect(ctx).toEqual({ customerId: null, leadId: "lead-1" });
    expect(f.queries).toHaveLength(1);
    expect(flat(f.queries[0]!.sql)).toContain("FROM leads WHERE is_archived = FALSE");
  });

  it("falls back to historical customers only when no lead matches", async () => {
    const f = fakeDb();
    f.queue([], [{ id: "cust-1" }]);
    const ctx = await new CommunicationsRepository(f.db as unknown as Database).resolvePhoneContext("0400111222");
    expect(ctx).toEqual({ customerId: "cust-1", leadId: null });
    expect(flat(f.queries[1]!.sql)).toContain("FROM customers");
  });

  it("a number without digits matches nobody", async () => {
    const f = fakeDb();
    expect(await new CommunicationsRepository(f.db as unknown as Database).resolvePhoneContext("unknown")).toEqual({
      customerId: null,
      leadId: null,
    });
    expect(f.queries).toHaveLength(0);
  });
});
