import type { EvidenceContribution, EvidencePacket, VisualHiveVerdict } from "../evidence/types.js";
import type { UxScoutContext } from "../ux/types.js";

export type HandoffMode = "dry_run" | "github_issue" | "bead_api";
export type HandoffStatus = "ready" | "blocked";
export type HandoffWorkItemKind = "repair" | "test_creation" | "review" | "setup";
export type HandoffPriority = "low" | "medium" | "high" | "critical";

export interface HandoffWorkItem {
  id: string;
  kind: HandoffWorkItemKind;
  priority: HandoffPriority;
  title: string;
  summary: string;
  evidenceKeys: string[];
  artifacts: string[];
  suggestedNextSteps: string[];
}

export interface HandoffPacket {
  schemaVersion: "visual-hive.handoff.v1";
  generatedAt: string;
  project: string;
  mode: HandoffMode;
  status: HandoffStatus;
  externalCallsMade: 0;
  sourceEvidencePacket: string;
  labels: string[];
  verdict: {
    visualHiveVerdict: VisualHiveVerdict;
    failedBecause: string[];
    warningBecause: string[];
    blockedBecause: string[];
    advisoryOnly: string[];
  };
  governance: {
    verdictAuthority: "visual_hive";
    handoffAuthority: "advisory_repair_routing";
    networkPolicy: "no_network_calls_in_dry_run";
    secretPolicy: "redacted_values_names_only";
    requiresHumanApprovalFor: string[];
  };
  workItems: HandoffWorkItem[];
  uxScoutContext: UxScoutContext;
  githubIssue: {
    title: string;
    labels: string[];
    bodyPath: string;
    dedupeSignature: string;
    trustedWorkflowRequired: true;
  };
  hiveBeadRequest: {
    dryRun: true;
    requestPath: string;
    agent: string;
    labels: string[];
    evidencePacketPath: string;
    handoffPacketPath: string;
    integrationEnabled: boolean;
    configuredMode: HandoffMode;
    beadApiUrl?: string;
    tokenEnv: string;
    tokenPresent: boolean;
    missingTokenEnv?: string;
  };
  blockedReasons: string[];
}

export interface HiveBeadDryRunRequest {
  schemaVersion: "visual-hive.hive-bead-request.v1";
  dryRun: true;
  externalCallsMade: 0;
  project: string;
  agent: string;
  labels: string[];
  objective: string;
  evidencePacketPath: string;
  handoffPacketPath: string;
  issueBodyPath: string;
  target: {
    integrationEnabled: boolean;
    configuredMode: HandoffMode;
    beadApiUrl?: string;
    tokenEnv: string;
    tokenPresent: boolean;
    missingTokenEnv?: string;
  };
  verdict: HandoffPacket["verdict"];
  workItems: HandoffWorkItem[];
  allowedActions: string[];
  forbiddenActions: string[];
}

export interface HiveHandoffResult {
  schemaVersion: "visual-hive.hive-handoff-result.v1";
  generatedAt: string;
  project: string;
  mode: HandoffMode;
  status: "dry_run_written" | "blocked";
  externalCallsMade: 0;
  artifacts: {
    handoff: string;
    issue: string;
    beadRequest: string;
    result: string;
    evidencePacket: string;
  };
  blockedReasons: string[];
  message: string;
}

export interface BuildHandoffOptions {
  evidencePacket: EvidencePacket;
  uxScoutContext?: UxScoutContext;
  evidencePacketPath: string;
  rootDir?: string;
  handoffPacketPath?: string;
  issueBodyPath?: string;
  beadRequestPath?: string;
  resultPath?: string;
  mode?: HandoffMode;
  labels?: string[];
  agent?: string;
  hiveIntegration?: {
    enabled?: boolean;
    mode?: HandoffMode;
    beadApi?: {
      url?: string;
      tokenEnv?: string;
      agent?: string;
      tokenPresent?: boolean;
    };
  };
  now?: Date;
}

export interface HandoffArtifacts {
  handoff: HandoffPacket;
  issueBody: string;
  beadRequest: HiveBeadDryRunRequest;
  result: HiveHandoffResult;
}

export function contributionKey(contribution: EvidenceContribution): string {
  const id = contribution.contractId ?? contribution.operator ?? contribution.providerId;
  return [contribution.source, contribution.kind, id].filter(Boolean).join(".");
}
