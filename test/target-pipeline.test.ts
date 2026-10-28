import { describe, expect, it } from "vitest";
import { activityKindFor, pipelineKindFor, TargetsService } from "../src/modules/targets/targets.service.js";
import { fakeDb } from "./helpers/fake-db.js";

describe("target pipeline filter", () => {
  it("knows which pipeline kind each metric counts in", () => {
    expect(pipelineKindFor("leads")).toBe("leads");
    expect(pipelineKindFor("open_lead_value")).toBe("leads");
    expect(pipelineKindFor("won_revenue")).toBe("sales");
    expect(pipelineKindFor("activities")).toBeNull();
    expect(pipelineKindFor("activities_calls")).toBeNull();
    expect(pipelineKindFor("activities_meetings")).toBeNull();
  });

  it("maps activity metrics to a kind filter", () => {
    expect(activityKindFor("activities")).toBe("");
    expect(activityKindFor("activities_calls")).toBe("call");
    expect(activityKindFor("activities_meetings")).toBe("meeting");
  });

  const check = (kind: string | null, metric: string, pipelineId: string | null = "p-1") => {
    const f = fakeDb();
    f.queue(kind === null ? [] : [{ kind }]);
    const svc = new TargetsService(f.db, {} as never);
    return svc["checkPipeline"](metric, pipelineId);
  };

  it("rejects a lead target on a deals pipeline, and the reverse", async () => {
    await expect(check("sales", "leads")).rejects.toThrow("lead targets can only count a lead pipeline");
    await expect(check("leads", "won_revenue")).rejects.toThrow("deal targets can only count a sales pipeline");
    await expect(check(null, "leads")).rejects.toThrow("pipeline not found");
  });

  it("accepts matching pipelines, activities on any pipeline, and no pipeline", async () => {
    await expect(check("leads", "leads")).resolves.toBeUndefined();
    await expect(check("sales", "activities")).resolves.toBeUndefined();
    await expect(check(null, "leads", null)).resolves.toBeUndefined();
  });
});
