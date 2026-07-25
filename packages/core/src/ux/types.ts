import type { EvidencePacket } from "../evidence/types.js";
import type { FlowAuditEntry, FlowAuditReport } from "../flows/audit.js";

export interface UxFlowContext {
  id: string;
  contractId: string;
  targetId: string;
  severity: FlowAuditEntry["severity"];
  selected: boolean;
  status: FlowAuditEntry["latestStatus"];
  routes: string[];
  selectors: string[];
  changedFiles: string[];
  failedSteps: string[];
  evidence: string[];
}

export interface UxScoutContext {
  schemaVersion: "visual-hive.ux-scout-context.v1";
  generatedAt: string;
  project: string;
  trigger: "affected-flow";
  visualHiveVerdict: EvidencePacket["verdictSummary"]["visualHiveVerdict"];
  changedFiles: string[];
  affectedFlows: UxFlowContext[];
  sourceArtifacts: string[];
  guardrails: string[];
}

export function buildUxScoutContext(options: {
  flows: FlowAuditReport;
  evidence: EvidencePacket;
  changedFiles?: string[];
  now?: Date;
}): UxScoutContext {
  const changedFiles = [...new Set(options.changedFiles ?? options.evidence.plan?.effectiveChangedFiles ?? options.evidence.plan?.changedFiles ?? [])];
  const affectedFlows = options.flows.flows
    .filter((flow) => flow.selected && flow.steps.length > 0)
    .map((flow) => ({
      id: flow.contractId,
      contractId: flow.contractId,
      targetId: flow.targetId,
      severity: flow.severity,
      selected: flow.selected,
      status: flow.latestStatus,
      routes: [...new Set(flow.steps.map((step) => step.route).filter((route): route is string => Boolean(route)))],
      selectors: [...new Set(flow.steps.map((step) => step.selector).filter((selector): selector is string => Boolean(selector)))],
      changedFiles,
      failedSteps: flow.latestFailedMessages,
      evidence: [
        `.visual-hive/flows.json#${flow.contractId}`,
        ...(flow.latestFailedSteps > 0 ? [".visual-hive/report.json"] : []),
        ".visual-hive/evidence-packet.json"
      ]
    }));

  return {
    schemaVersion: "visual-hive.ux-scout-context.v1",
    generatedAt: (options.now ?? new Date()).toISOString(),
    project: options.flows.project,
    trigger: "affected-flow",
    visualHiveVerdict: options.evidence.verdictSummary.visualHiveVerdict,
    changedFiles,
    affectedFlows,
    sourceArtifacts: [".visual-hive/flows.json", ".visual-hive/evidence-packet.json", ".visual-hive/handoff.json"],
    guardrails: [
      "UX Scout reviews only affectedFlows in this context.",
      "Visual Hive remains the deterministic verdict authority.",
      "UX Scout is advisory-only and must not modify baselines, thresholds, or source code."
    ]
  };
}
