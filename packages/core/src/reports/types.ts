import type { PlanMode } from "../planner/types.js";
import type { EvidenceContribution, VerdictSummary } from "../evidence/types.js";
import type { UxScoutResult } from "../ux/result.js";

export type ContractStatus = "passed" | "failed" | "created" | "skipped";
export type MutationStatus = "killed" | "survived" | "not_applicable" | "error";
export type TriageClassification =
  | "visual_diff"
  | "created_baseline"
  | "missing_element"
  | "unexpected_element"
  | "login_regression"
  | "api_contract_regression"
  | "console_error"
  | "page_error"
  | "target_startup_failure"
  | "missing_baseline"
  | "no_contracts_selected"
  | "possible_flake"
  | "environment_failure"
  | "coverage_gap"
  | "mutation_survivor"
  | "provider_failure"
  | "flaky_baseline"
  | "protected_target_missing_secret"
  | "insufficient_coverage"
  | "provider_cost_policy_skipped"
  | "external_upload_blocked";

export interface SelectorAssertionResult {
  kind: "mustExist" | "mustNotExist" | "textMustExist" | "textMustNotExist" | "waitFor";
  value: string;
  status: "passed" | "failed";
  message?: string;
}

export interface FlowStepResult {
  action: "goto" | "click" | "fill" | "press" | "waitFor" | "assertVisible" | "assertHidden" | "assertText" | "assertUrl";
  description?: string;
  selector?: string;
  route?: string;
  value?: string;
  status: "passed" | "failed";
  durationMs: number;
  message?: string;
}

export interface ScreenshotAssertionResult {
  contractId: string;
  screenshotName: string;
  name: string;
  route: string;
  viewport: string;
  status: "passed" | "failed" | "created" | "missing_baseline";
  baselinePath: string;
  actualPath: string;
  diffPath?: string;
  maxDiffPixelRatio: number;
  maxDiffPixels?: number;
  actualDiffPixelRatio?: number;
  actualDiffPixels?: number;
  diffPixels?: number;
  totalPixels: number;
  message?: string;
}

export interface RuntimeErrorResult {
  type: "console" | "page";
  message: string;
}

export interface NetworkErrorResult {
  type: "network";
  url: string;
  status: number;
  statusText: string;
}

export interface TargetLifecycleEvent {
  targetId: string;
  serviceName?: string;
  phase: "install" | "build" | "setup" | "serve" | "service" | "teardown";
  status: "started" | "passed" | "failed" | "stopped";
  durationMs: number;
  command?: string;
  url?: string;
  message?: string;
}

export interface ProviderResult {
  providerId: string;
  label: string;
  status: "passed" | "failed" | "skipped" | "missing_credentials" | "mock";
  deterministicRole: "oracle" | "supplemental";
  message: string;
  requiredEnv: string[];
  missingEnv: string[];
  artifactCount: number;
  externalUploadAllowed?: boolean;
  externalUploadBlockedReasons?: string[];
  estimatedExternalScreenshots?: number;
  externalUrl?: string;
  upload?: {
    status: "uploaded" | "skipped" | "blocked" | "missing_credentials" | "failed" | "dry_run";
    externalCallsMade: number;
    uploadedArtifacts: number;
    stagedArtifacts: number;
    manifestPath?: string;
    uploadDirectory?: string;
    command?: string;
    stdout?: string;
    stderr?: string;
    providerUrl?: string;
    blockedReasons?: string[];
  };
  normalizedAt: string;
}

export interface RepositoryMetadata {
  provider: "local" | "github-actions";
  repository: string;
  owner?: string;
  repo?: string;
  remoteUrl?: string;
  branch?: string;
  baseBranch?: string;
  commitSha?: string;
  pullRequestNumber?: number;
  runId?: string;
  runAttempt?: string;
  workflow?: string;
  actor?: string;
}

export interface ReportSummary {
  passed: number;
  failed: number;
  screenshotsPassed: number;
  screenshotsFailed: number;
  baselinesCreated: number;
  createdBaselines: number;
  missingBaselines: number;
  visualDiffs: number;
  consoleErrors: number;
  pageErrors: number;
  flowStepsPassed?: number;
  flowStepsFailed?: number;
}

export interface ReportOutputResource {
  artifactPath: string;
  evidenceResourceId: string;
  evidenceResourceUri: string;
  evidenceResourceTitle: string;
  evidenceResourceDescription: string;
  evidenceReadToolName?: string;
}

export interface ContractResult {
  contractId: string;
  mutationOperator?: string;
  targetId: string;
  status: ContractStatus;
  durationMs: number;
  errors: string[];
  artifacts: string[];
  reproductionCommand?: string;
  selectorAssertions?: SelectorAssertionResult[];
  flowSteps?: FlowStepResult[];
  screenshotAssertions?: ScreenshotAssertionResult[];
  consoleErrors?: RuntimeErrorResult[];
  pageErrors?: RuntimeErrorResult[];
  networkErrors?: NetworkErrorResult[];
}

export interface Report {
  schemaVersion: 2;
  project: string;
  outputResource?: ReportOutputResource;
  repository: RepositoryMetadata;
  mode: PlanMode;
  generatedAt: string;
  status: "passed" | "failed";
  changedFiles: string[];
  selectedTargets: Array<{ id: string; kind: string; url: string; prSafe: boolean; cost: string; missingSecrets?: string[] }>;
  selectedContracts: string[];
  excludedContracts: Array<{ contractId: string; targetId: string; reasons: string[] }>;
  targetLifecycle: TargetLifecycleEvent[];
  generatedSpecPath: string;
  results: ContractResult[];
  summary: ReportSummary;
  consoleErrors: string[];
  pageErrors: RuntimeErrorResult[];
  artifacts: string[];
  providerResults?: ProviderResult[];
  reproductionCommands: string[];
  verdictSummary?: VerdictSummary;
  verdictContributions?: EvidenceContribution[];
  uxScout?: UxScoutResult;
  noContractsReason?: string;
}

export interface MutationResult {
  operator: string;
  status: MutationStatus;
  killed: boolean;
  contractIds: string[];
  applicable: boolean;
  affected?: MutationAffectedSurface[];
  affectedSurfaces?: MutationAffectedSurface[];
  expectedFailureKinds?: string[];
  failureKind?: string;
  failedAssertion?: string;
  durationMs: number;
  errors: string[];
  artifacts?: string[];
  validationCommand?: string;
  suggestedMissingTest?: string;
  mutationMode?: "runtime" | "fixture" | "source";
  sourceMutation?: boolean;
}

export interface MutationAffectedSurface {
  contractId: string;
  targetId?: string;
  route?: string;
  component?: string;
  viewport?: string;
}

export interface MutationReportOutputResource {
  artifactPath: string;
  evidenceResourceId: string;
  evidenceResourceUri: string;
  evidenceResourceTitle: string;
  evidenceResourceDescription: string;
  evidenceReadToolName?: string;
}

export interface MutationReport {
  schemaVersion: 2;
  project: string;
  generatedAt: string;
  outputResource?: MutationReportOutputResource;
  minScore: number;
  score: number;
  killed: number;
  total: number;
  results: MutationResult[];
}

export interface TriageFinding {
  classification: TriageClassification;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  evidence: string[];
  contractIds?: string[];
  targetIds?: string[];
  suggestedFiles?: string[];
  suggestedNextTests: string[];
}

export interface TriageReportSummary {
  findingCount: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  classifications: Record<string, number>;
}

export interface TriageReportOutputResource {
  artifactPath: string;
  evidenceResourceId: string;
  evidenceResourceUri: string;
  evidenceResourceTitle: string;
  evidenceResourceDescription: string;
  evidenceReadToolName?: string;
}

export interface TriageReport {
  schemaVersion: 1;
  project: string;
  generatedAt: string;
  outputResource?: TriageReportOutputResource;
  sourceArtifacts: {
    report?: string;
    mutationReport?: string;
    coverageReport?: string;
    providerResults?: string;
    baselineApprovals?: string;
    baselineRejections?: string;
  };
  summary: TriageReportSummary;
  findings: TriageFinding[];
}
