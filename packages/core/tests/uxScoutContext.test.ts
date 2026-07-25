import { describe, expect, it } from "vitest";
import { buildUxScoutContext, type FlowAuditReport } from "../src/index.js";
import type { EvidencePacket } from "../src/evidence/types.js";

const evidence = {
  project: "visual-hive-demo-site",
  verdictSummary: { visualHiveVerdict: "failed" },
  plan: { changedFiles: ["src/App.tsx"], effectiveChangedFiles: ["src/App.tsx"] }
} as EvidencePacket;

function flow(contractId: string, selected: boolean): FlowAuditReport["flows"][number] {
  return {
    contractId,
    targetId: "localPreview",
    targetKind: "localPreview",
    severity: "high",
    selected,
    runOn: { pullRequest: true, schedule: true },
    steps: [{ index: 0, action: "goto", route: "/scenarios?issue=api-500", timeoutMs: 5000, category: "navigation" }],
    latestStatus: selected ? "failed" : "not_run",
    latestPassedSteps: 0,
    latestFailedSteps: selected ? 1 : 0,
    latestFailedMessages: selected ? ["error-banner was not visible"] : [],
    gaps: [],
    recommendations: []
  };
}

describe("UX Scout context handoff", () => {
  it("hands only selected affected flows to UX Scout", () => {
    const context = buildUxScoutContext({
      flows: {
        schemaVersion: 1,
        project: "visual-hive-demo-site",
        generatedAt: "2026-01-01T00:00:00.000Z",
        summary: {} as FlowAuditReport["summary"],
        flows: [flow("api-error-state-contract", true), flow("dashboard-shell", false)],
        recommendations: []
      },
      evidence,
      now: new Date("2026-01-01T00:00:00.000Z")
    });

    expect(context.trigger).toBe("affected-flow");
    expect(context.changedFiles).toEqual(["src/App.tsx"]);
    expect(context.affectedFlows.map((item) => item.id)).toEqual(["api-error-state-contract"]);
    expect(context.affectedFlows[0]).toMatchObject({
      routes: ["/scenarios?issue=api-500"],
      failedSteps: ["error-banner was not visible"]
    });
  });

  it("does not trigger a UX review when no flow is selected", () => {
    const context = buildUxScoutContext({
      flows: {
        schemaVersion: 1,
        project: "visual-hive-demo-site",
        generatedAt: "2026-01-01T00:00:00.000Z",
        summary: {} as FlowAuditReport["summary"],
        flows: [flow("api-error-state-contract", false)],
        recommendations: []
      },
      evidence
    });

    expect(context.affectedFlows).toEqual([]);
  });
});
