import { describe, expect, it } from "vitest";
import { renderMarkdownReport } from "../src/commands/report.js";
import type { Report, UxScoutResult } from "@visual-hive/core";

const report = {
  schemaVersion: 2,
  project: "visual-hive-demo-site",
  repository: { provider: "local", repository: "visual-hive-demo-site" },
  mode: "pr",
  generatedAt: "2026-01-01T00:00:00.000Z",
  status: "failed",
  changedFiles: ["src/App.tsx"],
  selectedTargets: [],
  selectedContracts: [],
  excludedContracts: [],
  targetLifecycle: [],
  generatedSpecPath: ".visual-hive/generated.spec.ts",
  results: [],
  summary: {
    passed: 0,
    failed: 1,
    screenshotsPassed: 0,
    screenshotsFailed: 1,
    baselinesCreated: 0,
    createdBaselines: 0,
    missingBaselines: 0,
    visualDiffs: 1,
    consoleErrors: 0,
    pageErrors: 0
  },
  consoleErrors: [],
  pageErrors: [],
  artifacts: [],
  reproductionCommands: [],
  verdictSummary: {
    visualHiveVerdict: "failed",
    failedBecause: ["Visual diff exceeded threshold"],
    warningBecause: [],
    blockedBecause: [],
    advisoryOnly: []
  },
  uxScout: {
    schemaVersion: "visual-hive.ux-scout-result.v1",
    generatedAt: "2026-01-01T00:01:00.000Z",
    project: "visual-hive-demo-site",
    status: "completed",
    advisoryOnly: true,
    sourceContext: ".visual-hive/ux-scout-context.json",
    affectedFlows: ["api-error-state-contract"],
    findings: [
      {
        id: "ux-1",
        flowId: "api-error-state-contract",
        severity: "medium",
        category: "feedback",
        title: "Error feedback is not actionable",
        summary: "The error state does not explain the next step.",
        recommendation: "Tell the user how to retry or recover.",
        evidence: [".visual-hive/evidence-packet.json"]
      }
    ]
  }
} as Report & { uxScout: UxScoutResult };

describe("UX Scout report advisory", () => {
  it("renders UX findings without changing the Visual Hive verdict", () => {
    const output = renderMarkdownReport(report);

    expect(output).toContain("- Deterministic status: failed");
    expect(output).toContain("### UX Scout Advisory");
    expect(output).toContain("- Advisory only: true");
    expect(output).toContain("[medium] feedback: Error feedback is not actionable");
    expect(report.status).toBe("failed");
    expect(report.verdictSummary?.visualHiveVerdict).toBe("failed");
  });
});
