export type VisualHiveIssueKind =
  | "setup_needed"
  | "map_drift"
  | "missing_visual_coverage"
  | "test_adequacy_gap"
  | "weak_visual_test"
  | "stale_baseline"
  | "baseline_churn"
  | "visual_regression"
  | "selector_contract_failure"
  | "screenshot_diff"
  | "mutation_survivor"
  | "workflow_safety"
  | "provider_governance"
  | "protected_target_blocked"
  | "external_repo_onboarding";

export type VisualHiveIssueSeverity = "low" | "medium" | "high" | "critical";
export type VisualHiveIssueStatus = "open_candidate" | "update_candidate" | "resolved_candidate" | "suppressed" | "blocked";
export type VisualHiveOwningAgentHint =
  | "visual-hive/setup"
  | "visual-hive/map"
  | "visual-hive/test-creator"
  | "visual-hive/test-maintainer"
  | "visual-hive/mutation"
  | "hive/quality"
  | "hive/ci"
  | "hive/architect";

export interface VisualHiveIssueAffectedSurface {
  route?: string;
  component?: string;
  contractId?: string;
  selector?: string;
  viewport?: string;
  targetId?: string;
}

export interface VisualHiveIssueCandidate {
  issueKind: VisualHiveIssueKind;
  severity: VisualHiveIssueSeverity;
  status: VisualHiveIssueStatus;
  dedupeFingerprint: string;
  title: string;
  labels: string[];
  body: string;
  owningAgentHint: VisualHiveOwningAgentHint;
  sourceArtifacts: string[];
  affected: VisualHiveIssueAffectedSurface[];
  reproductionCommand?: string;
  validationCommand: string;
  linkedEvidencePacket?: string;
  linkedRepoMap?: string;
  linkedVisualGraph?: string;
  linkedVisualImpact?: string;
  linkedMutationReport?: string;
  linkedHandoff?: string;
  linkedHiveExport?: string;
  linkedKnowledgeGraph?: string;
  linkedAgentPacket?: string;
  guardrails: string[];
  suppressedReason?: string;
  suppressionExpiresAt?: string;
}

export interface VisualHiveIssueSuppression {
  dedupeFingerprint: string;
  reason: string;
  expiresAt?: string;
}

export interface VisualHiveIssuesReport {
  schemaVersion: "visual-hive.issues.v1";
  generatedAt: string;
  project: string;
  externalCallsMade: 0;
  networkCallsMade: 0;
  sourceArtifacts: {
    report?: string;
    mutationReport?: string;
    coverage?: string;
    coverageRecommendations?: string;
    testCreationPlan?: string;
    triage?: string;
    repoMap?: string;
    visualGraph?: string;
    visualImpact?: string;
    workflows?: string;
    readiness?: string;
    evidencePacket?: string;
    handoff?: string;
    uxScoutResult?: string;
    hiveExport?: string;
    knowledgeGraph?: string;
    agentPacket?: string;
  };
  summary: {
    total: number;
    openCandidates: number;
    updateCandidates: number;
    resolvedCandidates: number;
    suppressed: number;
    blocked: number;
    byKind: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  issues: VisualHiveIssueCandidate[];
}

export interface VisualHiveIssueQueue {
  schemaVersion: "visual-hive.issue-queue.v1";
  generatedAt: string;
  project: string;
  externalCallsMade: 0;
  networkCallsMade: 0;
  summary: {
    total: number;
    readyForHive: number;
    readyForVisualHiveAgent: number;
    blockedPolicy: number;
    blockedMissingArtifact: number;
    resolvedCandidates: number;
    suppressed: number;
  };
  labels: string[];
  queues: {
    ready_for_hive: VisualHiveIssueCandidate[];
    ready_for_visual_hive_agent: VisualHiveIssueCandidate[];
    blocked_policy: VisualHiveIssueCandidate[];
    blocked_missing_artifact: VisualHiveIssueCandidate[];
    resolved_candidate: VisualHiveIssueCandidate[];
    suppressed: VisualHiveIssueCandidate[];
  };
}

export interface VisualHiveSetupIssue {
  schemaVersion: "visual-hive.setup-issue.v1";
  generatedAt: string;
  project: string;
  title: string;
  labels: string[];
  body: string;
  externalCallsMade: 0;
  networkCallsMade: 0;
  sourceArtifacts: string[];
}

export type VisualHiveIssuePublishMode = "dry_run" | "live";
export type VisualHiveIssuePublishStatus = "ready" | "blocked" | "dry_run_written" | "published" | "failed";
export type VisualHiveIssuePublishAction = "create" | "update" | "skip" | "blocked";

export interface VisualHivePublishedIssueRef {
  number: number;
  url: string;
  dedupeFingerprint: string;
  title: string;
  labels: string[];
}

export interface VisualHiveIssuePublishDecision {
  dedupeFingerprint: string;
  issueKind: VisualHiveIssueKind;
  title: string;
  status: VisualHiveIssueStatus;
  severity: VisualHiveIssueSeverity;
  action: VisualHiveIssuePublishAction;
  reason: string;
  labels: string[];
  owningAgentHint: VisualHiveOwningAgentHint;
  validationCommand: string;
  existingIssue?: VisualHivePublishedIssueRef;
  targetIssue?: VisualHivePublishedIssueRef;
  body: string;
}

export interface VisualHiveIssuePublishPlan {
  schemaVersion: "visual-hive.issue-publish-plan.v1";
  generatedAt: string;
  project: string;
  mode: VisualHiveIssuePublishMode;
  status: "ready" | "blocked";
  externalCallsMade: 0;
  networkCallsMade: 0;
  sourceArtifacts: {
    issues: string;
    handoffValidation?: string;
  };
  summary: {
    total: number;
    create: number;
    update: number;
    skip: number;
    blocked: number;
    suppressed: number;
    resolvedCandidates: number;
  };
  blockedReasons: string[];
  decisions: VisualHiveIssuePublishDecision[];
}

export interface VisualHiveIssuePublishDryRun {
  schemaVersion: "visual-hive.issue-publish-dry-run.v1";
  generatedAt: string;
  project: string;
  status: "ready" | "blocked";
  externalCallsMade: 0;
  networkCallsMade: 0;
  wouldCreateIssues: number;
  wouldUpdateIssues: number;
  wouldSkipIssues: number;
  wouldBlockIssues: number;
  decisions: VisualHiveIssuePublishDecision[];
}

export interface VisualHiveIssuePublishResult {
  schemaVersion: "visual-hive.issue-publish-result.v1";
  generatedAt: string;
  project: string;
  mode: VisualHiveIssuePublishMode;
  status: VisualHiveIssuePublishStatus;
  externalCallsMade: number;
  networkCallsMade: number;
  realGithubIssuesCreated: number;
  realGithubIssuesUpdated: number;
  blockedReasons: string[];
  decisions: VisualHiveIssuePublishDecision[];
  createdIssues: VisualHivePublishedIssueRef[];
  updatedIssues: VisualHivePublishedIssueRef[];
}
