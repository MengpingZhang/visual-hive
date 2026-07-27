import path from "node:path";
import { writeJson, writeText } from "../utils/files.js";
import { sanitizeText } from "../utils/sanitize.js";
import type { HandoffMode, HandoffPacket, HandoffPriority, HandoffWorkItem } from "../handoff/types.js";
import type { EvidenceContribution, EvidencePacket } from "../evidence/types.js";
import { getEvidenceResourceById } from "../tools/evidenceResources.js";
import type {
  BuildHiveExportOptions,
  BuildHiveGuardedRepairPreviewOptions,
  BuildHiveModeComparisonOptions,
  BuildHiveRepairRequestEnvelopeOptions,
  BuildHiveTrustedRepairConsumerSummaryOptions,
  BuildHiveTrustedRepairWorkflowDryRunOptions,
  HiveAgentPolicy,
  HiveAutomationMode,
  HiveBead,
  HiveBeadActor,
  HiveBeadType,
  HiveCatalogedOutputResource,
  HiveConfiguredMode,
  HiveExportArtifacts,
  HiveExportBundle,
  HiveExportConfig,
  HiveExportOutputResource,
  HiveExportOutputResourceKey,
  HiveGuardedRepairPreview,
  HiveGuardedRepairPreviewWorkOrder,
  HiveModeComparison,
  HiveModeComparisonEntry,
  HiveGraphEdge,
  HiveGraphNode,
  HiveKnowledgeFact,
  HiveKnowledgeGraph,
  HiveProviderEvidenceSummary,
  HiveWikiIndex,
  HiveRepairRequestEnvelope,
  HiveRepairRequestEnvelopeItem,
  HiveTrustedRepairConsumerSummary,
  HiveTrustedRepairConsumerSummaryItem,
  HiveTrustedRepairWorkflowDryRun,
  HiveTrustedRepairWorkflowDryRunAction,
  HiveTrustedRepairWorkflowDryRunItem,
  HiveRepairWorkOrder,
  HiveSourceContext,
  HiveWorkSource,
  WriteHiveExportOptions,
  WriteHiveExportResult,
  WriteHiveGuardedRepairPreviewOptions,
  WriteHiveGuardedRepairPreviewResult,
  WriteHiveModeComparisonOptions,
  WriteHiveModeComparisonResult,
  WriteHiveRepairRequestEnvelopeOptions,
  WriteHiveRepairRequestEnvelopeResult,
  WriteHiveTrustedRepairConsumerSummaryOptions,
  WriteHiveTrustedRepairConsumerSummaryResult,
  WriteHiveTrustedRepairWorkflowDryRunOptions,
  WriteHiveTrustedRepairWorkflowDryRunResult
} from "./types.js";

const DEFAULT_OUTPUT_DIR = ".visual-hive/hive";
const DEFAULT_MODE_COMPARISON_MODES: HiveAutomationMode[] = ["advisory", "measured", "repair_request", "guarded_repair", "full"];
const DEFAULT_LABELS = ["visual-hive", "hive/quality", "ai-ready"];
const HIVE_EXPORT_OUTPUT_RESOURCE_MAP: Array<{
  artifactKey: HiveExportOutputResourceKey;
  resourceId: string;
}> = [
  { artifactKey: "export", resourceId: "hive-export" },
  { artifactKey: "beads", resourceId: "hive-beads" },
  { artifactKey: "knowledgeFacts", resourceId: "hive-knowledge-facts" },
  { artifactKey: "knowledgeGraph", resourceId: "hive-knowledge-graph" },
  { artifactKey: "wikiIndex", resourceId: "hive-wiki-index" },
  { artifactKey: "repairWorkOrders", resourceId: "hive-repair-work-orders" },
  { artifactKey: "agentPolicy", resourceId: "hive-agent-policy" }
];
const DEFAULT_CONFIG: HiveExportConfig = {
  enabled: false,
  mode: "advisory",
  acmmLevel: 3,
  defaultActor: "quality",
  labels: DEFAULT_LABELS,
  export: {
    beads: true,
    knowledgeFacts: true,
    knowledgeGraph: true,
    wikiVault: true,
    repairWorkOrders: true,
    maxFacts: 50
  },
  repair: {
    enabled: false,
    prOnly: true,
    maxAttempts: 1,
    requireHumanReview: true,
    rerunVisualHive: true,
    branchPrefix: "hive/visual-hive-"
  }
};

export function normalizeHiveAutomationMode(mode?: string): HiveAutomationMode {
  if (mode === "measured" || mode === "repair_request" || mode === "guarded_repair" || mode === "full" || mode === "advisory") {
    return mode;
  }
  if (mode === "github_issue" || mode === "bead_api") return "measured";
  return "advisory";
}

export function handoffModeFromHiveMode(mode?: string): HandoffMode {
  if (mode === "github_issue" || mode === "bead_api" || mode === "dry_run") return mode;
  return "dry_run";
}

export function normalizeHiveExportConfig(input?: BuildHiveExportOptions["hiveConfig"]): HiveExportConfig {
  const raw = (input ?? {}) as Partial<HiveExportConfig> & {
    mode?: HiveConfiguredMode;
    labels?: string[];
  };
  return sanitizeValue({
    ...DEFAULT_CONFIG,
    enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
    mode: raw.mode ?? DEFAULT_CONFIG.mode,
    acmmLevel: raw.acmmLevel ?? DEFAULT_CONFIG.acmmLevel,
    defaultActor: raw.defaultActor ?? DEFAULT_CONFIG.defaultActor,
    labels: dedupe([...(raw.labels?.length ? raw.labels : DEFAULT_CONFIG.labels), ...DEFAULT_LABELS]),
    export: {
      ...DEFAULT_CONFIG.export,
      ...(raw.export ?? {})
    },
    repair: {
      ...DEFAULT_CONFIG.repair,
      ...(raw.repair ?? {})
    }
  }) as HiveExportConfig;
}

export function buildHiveExportArtifacts(options: BuildHiveExportOptions): HiveExportArtifacts {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const config = normalizeHiveExportConfig(options.hiveConfig);
  const mode = normalizeHiveAutomationMode(config.mode);
  const outputDir = normalizePath(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const paths = outputPaths(outputDir);
  const context: HiveSourceContext = {
    evidence: sanitizeValue(options.evidencePacket) as EvidencePacket,
    handoff: options.handoffPacket ? (sanitizeValue(options.handoffPacket) as HandoffPacket) : undefined,
    config,
    mode,
    generatedAt
  };
  const workSources = buildWorkSources(context.evidence, context.handoff);
  const beads = shouldEmitMeasuredArtifacts(mode) && config.export.beads ? buildBeads(context, workSources) : [];
  const knowledgeFacts =
    shouldEmitMeasuredArtifacts(mode) && config.export.knowledgeFacts ? buildKnowledgeFacts(context, workSources, config.export.maxFacts) : [];
  const repairWorkOrders = shouldEmitRepairArtifacts(mode, config) && config.export.repairWorkOrders ? buildRepairWorkOrders(context, workSources, beads) : [];
  const knowledgeGraph =
    shouldEmitMeasuredArtifacts(mode) && config.export.knowledgeGraph
      ? buildKnowledgeGraph(context, beads, knowledgeFacts, repairWorkOrders)
      : emptyGraph();
  const agentPolicy = buildAgentPolicy(context);
  const blockedReasons = blockedReasonsFor(context);
  const wikiPages = config.export.wikiVault && knowledgeFacts.length ? knowledgeFacts.map((fact) => wikiPageFor(fact, paths.wikiVaultDir)) : [];
  const wikiIndex = buildWikiIndex(context, knowledgeFacts, wikiPages, paths.wikiVaultDir);
  const bundle: HiveExportBundle = sanitizeValue({
    schemaVersion: "visual-hive.hive-export.v1",
    generatedAt,
    project: context.evidence.project,
    status: blockedReasons.length ? "blocked" : "ready",
    externalCallsMade: 0,
    mode,
    configuredMode: config.mode,
    acmmLevel: config.acmmLevel,
    sourceArtifacts: {
      evidencePacket: normalizePath(options.evidencePacketPath),
      handoffPacket: options.handoffPacketPath ? normalizePath(options.handoffPacketPath) : undefined
    },
    outputArtifacts: paths,
    outputResources: hiveExportOutputResources(paths),
    governance: {
      verdictAuthority: "visual_hive",
      defaultMode: "advisory_no_network",
      repairAuthority: "hive_may_open_pr_only_when_trusted_policy_allows",
      validationRequired: "visual_hive_must_rerun_after_repair",
      secretPolicy: "redacted_values_names_only"
    },
    summary: {
      beads: beads.length,
      knowledgeFacts: knowledgeFacts.length,
      graphNodes: knowledgeGraph.nodes.length,
      graphEdges: knowledgeGraph.edges.length,
      wikiPages: wikiIndex.pages.length,
      repairWorkOrders: repairWorkOrders.length,
      blockedReasons: blockedReasons.length
    },
    labels: config.labels,
    providerEvidence: providerEvidenceFor(context.evidence),
    beads,
    knowledgeFacts,
    knowledgeGraph,
    wikiIndex,
    repairWorkOrders,
    agentPolicy,
    blockedReasons
  }) as HiveExportBundle;

  const issueContext = renderHiveIssueContext(bundle, context, workSources);
  return { bundle, issueContext, wikiIndex, wikiPages };
}

function hiveExportOutputResources(paths: HiveExportBundle["outputArtifacts"]): HiveExportOutputResource[] {
  return HIVE_EXPORT_OUTPUT_RESOURCE_MAP.map(({ artifactKey, resourceId }) => {
    return catalogedOutputResource(artifactKey, paths[artifactKey], resourceId) as HiveExportOutputResource;
  });
}

function catalogedOutputResource(artifactKey: string, artifactPath: string, resourceId: string): HiveCatalogedOutputResource {
  const resource = getEvidenceResourceById(resourceId);
  if (!resource) {
    throw new Error(`Missing Visual Hive evidence resource catalog entry for ${resourceId}.`);
  }
  return {
    artifactKey,
    artifactPath,
    evidenceResourceId: resource.id,
    evidenceResourceUri: resource.uri,
    evidenceResourceTitle: resource.title,
    evidenceResourceDescription: resource.description,
    evidenceReadToolName: resource.readTool?.name
  };
}

export async function writeHiveExportArtifacts(options: WriteHiveExportOptions): Promise<WriteHiveExportResult> {
  const artifacts = buildHiveExportArtifacts(options);
  const rootDir = path.resolve(options.rootDir);
  const paths = artifacts.bundle.outputArtifacts;
  await writeJson(resolveArtifact(rootDir, paths.export), artifacts.bundle);
  await writeJson(resolveArtifact(rootDir, paths.beads), artifacts.bundle.beads);
  await writeJson(resolveArtifact(rootDir, paths.knowledgeFacts), artifacts.bundle.knowledgeFacts);
  await writeJson(resolveArtifact(rootDir, paths.knowledgeGraph), artifacts.bundle.knowledgeGraph);
  await writeJson(resolveArtifact(rootDir, paths.wikiIndex), artifacts.wikiIndex);
  await writeJson(resolveArtifact(rootDir, paths.repairWorkOrders), artifacts.bundle.repairWorkOrders);
  await writeJson(resolveArtifact(rootDir, paths.agentPolicy), artifacts.bundle.agentPolicy);
  await writeText(resolveArtifact(rootDir, paths.issueContext), artifacts.issueContext);
  for (const page of artifacts.wikiPages) {
    await writeText(resolveArtifact(rootDir, page.path), page.content);
  }
  return { ...artifacts, paths };
}

export function renderHiveExportSummary(result: WriteHiveExportResult, format: "markdown" | "json" = "markdown"): string {
  if (format === "json") return JSON.stringify(result.bundle, null, 2);
  return [
    `Wrote ${result.paths.export}`,
    `Wrote ${result.paths.beads}`,
    `Wrote ${result.paths.knowledgeFacts}`,
    `Wrote ${result.paths.knowledgeGraph}`,
    `Wrote ${result.paths.wikiIndex}`,
    `Wrote ${result.paths.issueContext}`,
    `Wrote ${result.paths.repairWorkOrders}`,
    `Wrote ${result.paths.agentPolicy}`,
    "",
    `# Hive Native Export: ${result.bundle.project}`,
    "",
    `- Status: ${result.bundle.status}`,
    `- Mode: ${result.bundle.mode}`,
    `- ACMM level: ${result.bundle.acmmLevel}`,
    `- External calls made: ${result.bundle.externalCallsMade}`,
    `- Beads: ${result.bundle.summary.beads}`,
    `- Knowledge facts: ${result.bundle.summary.knowledgeFacts}`,
    `- Graph: ${result.bundle.summary.graphNodes} nodes / ${result.bundle.summary.graphEdges} edges`,
    `- Wiki pages: ${result.bundle.summary.wikiPages}`,
    `- Repair work orders: ${result.bundle.summary.repairWorkOrders}`,
    ...(result.bundle.blockedReasons.length ? [`- Blocked reasons: ${result.bundle.blockedReasons.join("; ")}`] : [])
  ].join("\n");
}

export function buildHiveGuardedRepairPreview(options: BuildHiveGuardedRepairPreviewOptions): HiveGuardedRepairPreview {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const outputDir = normalizePath(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const paths = guardedRepairPreviewPaths(outputDir);
  const hiveExportPath = normalizePath(options.hiveExportPath);
  const exportBundle = sanitizeValue(options.hiveExport) as HiveExportBundle;
  const workOrders = exportBundle.repairWorkOrders.map((order) => guardedRepairWorkOrder(order));
  const blockedReasons = guardedRepairPreviewBlockedReasons(exportBundle, workOrders);
  const readyWorkOrders = workOrders.filter((order) => order.blockedReasons.length === 0).length;
  const blockedWorkOrders = workOrders.length - readyWorkOrders;
  const preview: HiveGuardedRepairPreview = sanitizeValue({
    schemaVersion: "visual-hive.hive-guarded-repair-preview.v1",
    generatedAt,
    project: exportBundle.project,
    status: blockedReasons.length ? "blocked" : "ready",
    externalCallsMade: 0,
    sourceArtifacts: {
      hiveExport: hiveExportPath,
      repairWorkOrders: exportBundle.outputArtifacts.repairWorkOrders,
      agentPolicy: exportBundle.outputArtifacts.agentPolicy,
      evidencePacket: exportBundle.sourceArtifacts.evidencePacket,
      handoffPacket: exportBundle.sourceArtifacts.handoffPacket
    },
    outputArtifacts: paths,
    outputResource: catalogedOutputResource("preview", paths.preview, "hive-guarded-repair-preview"),
    policy: {
      verdictAuthority: "visual_hive",
      repairExecution: "preview_only_no_execution",
      branchIsolationRequired: true,
      pullRequestOnly: exportBundle.agentPolicy.repair.prOnly,
      humanReviewRequired: exportBundle.agentPolicy.repair.requireHumanReview,
      visualHiveRerunRequired: exportBundle.agentPolicy.repair.rerunVisualHive,
      protectedTargetsFromPr: false,
      externalNetworkCalls: false,
      secretsPolicy: "names_only_values_redacted"
    },
    readiness: {
      canRequestGuardedRepair: blockedReasons.length === 0,
      blockedReasons,
      requiredApprovals: guardedRepairApprovals(exportBundle),
      requiredCommands: dedupe([exportBundle.agentPolicy.finalValidation.command, ...workOrders.flatMap((order) => order.reproductionCommands)])
    },
    summary: {
      repairWorkOrders: workOrders.length,
      readyWorkOrders,
      blockedWorkOrders,
      allowedActions: dedupe(workOrders.flatMap((order) => order.allowedActions)).length,
      forbiddenActions: dedupe(workOrders.flatMap((order) => order.forbiddenActions)).length
    },
    workOrders
  }) as HiveGuardedRepairPreview;
  return preview;
}

export async function writeHiveGuardedRepairPreview(options: WriteHiveGuardedRepairPreviewOptions): Promise<WriteHiveGuardedRepairPreviewResult> {
  const rootDir = path.resolve(options.rootDir);
  const preview = buildHiveGuardedRepairPreview(options);
  const markdown = renderHiveGuardedRepairPreviewMarkdown(preview);
  await writeJson(resolveArtifact(rootDir, preview.outputArtifacts.preview), preview);
  await writeText(resolveArtifact(rootDir, preview.outputArtifacts.markdown), markdown);
  return { preview, markdown, paths: preview.outputArtifacts };
}

export function renderHiveGuardedRepairPreviewSummary(
  result: WriteHiveGuardedRepairPreviewResult,
  format: "markdown" | "json" = "markdown"
): string {
  if (format === "json") return JSON.stringify(result.preview, null, 2);
  return [
    `Wrote ${result.paths.preview}`,
    `Wrote ${result.paths.markdown}`,
    "",
    `# Hive Guarded Repair Preview: ${result.preview.project}`,
    "",
    `- Status: ${result.preview.status}`,
    `- External calls made: ${result.preview.externalCallsMade}`,
    `- Can request guarded repair: ${result.preview.readiness.canRequestGuardedRepair}`,
    `- Repair work orders: ${result.preview.summary.repairWorkOrders}`,
    `- Ready work orders: ${result.preview.summary.readyWorkOrders}`,
    `- Blocked work orders: ${result.preview.summary.blockedWorkOrders}`,
    ...(result.preview.readiness.blockedReasons.length ? [`- Blocked reasons: ${result.preview.readiness.blockedReasons.join("; ")}`] : [])
  ].join("\n");
}

export function buildHiveRepairRequestEnvelope(options: BuildHiveRepairRequestEnvelopeOptions): HiveRepairRequestEnvelope {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const outputDir = normalizePath(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const preview = sanitizeValue(options.guardedRepairPreview) as HiveGuardedRepairPreview;
  const previewPath = normalizePath(options.guardedRepairPreviewPath);
  const paths = repairRequestEnvelopePaths(outputDir);
  const requests = preview.workOrders.map((order) => repairRequestEnvelopeItem(order, preview));
  const blockedReasons = repairRequestEnvelopeBlockedReasons(preview, requests);
  const readyRequests = requests.filter((request) => request.blockedReasons.length === 0).length;
  const blockedRequests = requests.length - readyRequests;
  const envelope = sanitizeValue({
    schemaVersion: "visual-hive.hive-repair-request-envelope.v1",
    generatedAt,
    project: preview.project,
    status: blockedReasons.length ? "blocked" : "ready",
    externalCallsMade: 0,
    sourceArtifacts: {
      guardedRepairPreview: previewPath,
      hiveExport: preview.sourceArtifacts.hiveExport,
      repairWorkOrders: preview.sourceArtifacts.repairWorkOrders,
      agentPolicy: preview.sourceArtifacts.agentPolicy,
      evidencePacket: preview.sourceArtifacts.evidencePacket,
      handoffPacket: preview.sourceArtifacts.handoffPacket
    },
    outputArtifacts: paths,
    outputResource: catalogedOutputResource("envelope", paths.envelope, "hive-repair-request-envelope"),
    policy: {
      verdictAuthority: "visual_hive",
      requestExecution: "trusted_workflow_request_only",
      repairExecution: "not_executed_by_visual_hive",
      requiresTrustedWorkflow: true,
      branchIsolationRequired: true,
      pullRequestOnly: preview.policy.pullRequestOnly,
      humanReviewRequired: preview.policy.humanReviewRequired,
      visualHiveRerunRequired: preview.policy.visualHiveRerunRequired,
      externalNetworkCalls: false,
      protectedTargetsFromPr: false,
      secretsPolicy: "names_only_values_redacted"
    },
    github: {
      branchPrefix: repairBranchPrefix(preview),
      pullRequestTitlePrefix: "[visual-hive][hive-repair]",
      labels: ["visual-hive", "hive/quality", "hive/repair-request", "ai-ready"],
      dedupeKey: stableDedupeKey(preview.project, requests.map((request) => request.id).join("|"))
    },
    readiness: {
      canOpenTrustedRepairRequest: blockedReasons.length === 0,
      blockedReasons,
      requiredApprovals: preview.readiness.requiredApprovals,
      requiredCommands: preview.readiness.requiredCommands
    },
    summary: {
      repairRequests: requests.length,
      readyRequests,
      blockedRequests
    },
    requests
  }) as HiveRepairRequestEnvelope;
  return envelope;
}

export async function writeHiveRepairRequestEnvelope(options: WriteHiveRepairRequestEnvelopeOptions): Promise<WriteHiveRepairRequestEnvelopeResult> {
  const rootDir = path.resolve(options.rootDir);
  const envelope = buildHiveRepairRequestEnvelope(options);
  const markdown = renderHiveRepairRequestEnvelopeMarkdown(envelope);
  await writeJson(resolveArtifact(rootDir, envelope.outputArtifacts.envelope), envelope);
  await writeText(resolveArtifact(rootDir, envelope.outputArtifacts.markdown), markdown);
  return { envelope, markdown, paths: envelope.outputArtifacts };
}

export function renderHiveRepairRequestEnvelopeSummary(
  result: WriteHiveRepairRequestEnvelopeResult,
  format: "markdown" | "json" = "markdown"
): string {
  if (format === "json") return JSON.stringify(result.envelope, null, 2);
  return [
    `Wrote ${result.paths.envelope}`,
    `Wrote ${result.paths.markdown}`,
    "",
    `# Hive Repair Request Envelope: ${result.envelope.project}`,
    "",
    `- Status: ${result.envelope.status}`,
    `- External calls made: ${result.envelope.externalCallsMade}`,
    `- Can open trusted repair request: ${result.envelope.readiness.canOpenTrustedRepairRequest}`,
    `- Repair requests: ${result.envelope.summary.repairRequests}`,
    `- Ready requests: ${result.envelope.summary.readyRequests}`,
    `- Blocked requests: ${result.envelope.summary.blockedRequests}`,
    ...(result.envelope.readiness.blockedReasons.length ? [`- Blocked reasons: ${result.envelope.readiness.blockedReasons.join("; ")}`] : [])
  ].join("\n");
}

export function buildHiveTrustedRepairConsumerSummary(options: BuildHiveTrustedRepairConsumerSummaryOptions): HiveTrustedRepairConsumerSummary {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const outputDir = normalizePath(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const envelope = sanitizeValue(options.repairRequestEnvelope) as HiveRepairRequestEnvelope;
  const envelopePath = normalizePath(options.repairRequestEnvelopePath);
  const paths = trustedRepairConsumerSummaryPaths(outputDir);
  const items = envelope.requests.map((request) => trustedRepairConsumerSummaryItem(request, envelope));
  const blockedReasons = trustedRepairConsumerSummaryBlockedReasons(envelope, items);
  const readyRepairs = items.filter((item) => item.status === "ready").length;
  const blockedRepairs = items.length - readyRepairs;
  const summary = sanitizeValue({
    schemaVersion: "visual-hive.hive-trusted-repair-consumer-summary.v1",
    generatedAt,
    project: envelope.project,
    status: blockedReasons.length ? "blocked" : "ready",
    externalCallsMade: 0,
    sourceArtifacts: {
      repairRequestEnvelope: envelopePath,
      guardedRepairPreview: envelope.sourceArtifacts.guardedRepairPreview,
      hiveExport: envelope.sourceArtifacts.hiveExport,
      repairWorkOrders: envelope.sourceArtifacts.repairWorkOrders,
      agentPolicy: envelope.sourceArtifacts.agentPolicy,
      evidencePacket: envelope.sourceArtifacts.evidencePacket,
      handoffPacket: envelope.sourceArtifacts.handoffPacket
    },
    outputArtifacts: paths,
    outputResource: catalogedOutputResource("summary", paths.summary, "hive-trusted-repair-consumer-summary"),
    policy: {
      verdictAuthority: "visual_hive",
      consumerExecution: "dry_run_summary_only",
      repairExecution: "not_executed_by_visual_hive",
      checkoutCode: false,
      branchCreation: false,
      pullRequestCreation: false,
      issueCreation: false,
      hiveNetworkCalls: false,
      providerCalls: false,
      visualHiveRerun: false,
      requiresTrustedWorkflow: true,
      secretsPolicy: "names_only_values_redacted"
    },
    readiness: {
      canStartTrustedRepairWorkflow: blockedReasons.length === 0,
      blockedReasons,
      requiredApprovals: envelope.readiness.requiredApprovals,
      requiredCommands: envelope.readiness.requiredCommands
    },
    summary: {
      requestedRepairs: items.length,
      readyRepairs,
      blockedRepairs,
      branchesToCreate: readyRepairs,
      pullRequestsToOpen: readyRepairs,
      externalCallsMade: 0
    },
    consumerActions: {
      wouldCheckoutCode: false,
      wouldExecuteRepair: false,
      wouldCreateBranches: false,
      wouldOpenPullRequests: false,
      wouldCreateIssues: false,
      wouldCallHiveApi: false,
      wouldCallProviders: false,
      wouldRunVisualHive: false
    },
    items
  }) as HiveTrustedRepairConsumerSummary;
  return summary;
}

export async function writeHiveTrustedRepairConsumerSummary(
  options: WriteHiveTrustedRepairConsumerSummaryOptions
): Promise<WriteHiveTrustedRepairConsumerSummaryResult> {
  const rootDir = path.resolve(options.rootDir);
  const summary = buildHiveTrustedRepairConsumerSummary(options);
  const markdown = renderHiveTrustedRepairConsumerSummaryMarkdown(summary);
  await writeJson(resolveArtifact(rootDir, summary.outputArtifacts.summary), summary);
  await writeText(resolveArtifact(rootDir, summary.outputArtifacts.markdown), markdown);
  return { summary, markdown, paths: summary.outputArtifacts };
}

export function renderHiveTrustedRepairConsumerSummary(
  result: WriteHiveTrustedRepairConsumerSummaryResult,
  format: "markdown" | "json" = "markdown"
): string {
  if (format === "json") return JSON.stringify(result.summary, null, 2);
  return [
    `Wrote ${result.paths.summary}`,
    `Wrote ${result.paths.markdown}`,
    "",
    `# Hive Trusted Repair Consumer Summary: ${result.summary.project}`,
    "",
    `- Status: ${result.summary.status}`,
    `- External calls made: ${result.summary.externalCallsMade}`,
    `- Can start trusted repair workflow: ${result.summary.readiness.canStartTrustedRepairWorkflow}`,
    `- Requested repairs: ${result.summary.summary.requestedRepairs}`,
    `- Ready repairs: ${result.summary.summary.readyRepairs}`,
    `- Blocked repairs: ${result.summary.summary.blockedRepairs}`,
    `- Would checkout code: ${result.summary.consumerActions.wouldCheckoutCode}`,
    `- Would execute repair: ${result.summary.consumerActions.wouldExecuteRepair}`,
    `- Would create branches: ${result.summary.consumerActions.wouldCreateBranches}`,
    `- Would open pull requests: ${result.summary.consumerActions.wouldOpenPullRequests}`,
    `- Would call providers: ${result.summary.consumerActions.wouldCallProviders}`,
    ...(result.summary.readiness.blockedReasons.length ? [`- Blocked reasons: ${result.summary.readiness.blockedReasons.join("; ")}`] : [])
  ].join("\n");
}

export function buildHiveTrustedRepairWorkflowDryRun(options: BuildHiveTrustedRepairWorkflowDryRunOptions): HiveTrustedRepairWorkflowDryRun {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const outputDir = normalizePath(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const consumerSummary = sanitizeValue(options.trustedRepairConsumerSummary) as HiveTrustedRepairConsumerSummary;
  const consumerSummaryPath = normalizePath(options.trustedRepairConsumerSummaryPath);
  const paths = trustedRepairWorkflowDryRunPaths(outputDir);
  const items = consumerSummary.items.map((item) => trustedRepairWorkflowDryRunItem(item, consumerSummary));
  const blockedReasons = trustedRepairWorkflowDryRunBlockedReasons(consumerSummary, items);
  const readyRepairs = items.filter((item) => item.status === "ready").length;
  const blockedRepairs = items.length - readyRepairs;
  const plannedActions = items.flatMap((item) => item.plannedActions);
  const blockedActions = plannedActions.filter((action) => action.status === "blocked").length;
  const dryRun = sanitizeValue({
    schemaVersion: "visual-hive.hive-trusted-repair-workflow-dry-run.v1",
    generatedAt,
    project: consumerSummary.project,
    status: blockedReasons.length ? "blocked" : "ready",
    externalCallsMade: 0,
    sourceArtifacts: {
      trustedRepairConsumerSummary: consumerSummaryPath,
      repairRequestEnvelope: consumerSummary.sourceArtifacts.repairRequestEnvelope,
      guardedRepairPreview: consumerSummary.sourceArtifacts.guardedRepairPreview,
      hiveExport: consumerSummary.sourceArtifacts.hiveExport,
      repairWorkOrders: consumerSummary.sourceArtifacts.repairWorkOrders,
      agentPolicy: consumerSummary.sourceArtifacts.agentPolicy,
      evidencePacket: consumerSummary.sourceArtifacts.evidencePacket,
      handoffPacket: consumerSummary.sourceArtifacts.handoffPacket
    },
    outputArtifacts: paths,
    outputResource: catalogedOutputResource("dryRun", paths.dryRun, "hive-trusted-repair-workflow-dry-run"),
    policy: {
      verdictAuthority: "visual_hive",
      workflowExecution: "dry_run_only",
      repairExecution: "not_executed_by_visual_hive",
      checkoutCode: false,
      branchCreation: false,
      pullRequestCreation: false,
      issueCreation: false,
      hiveNetworkCalls: false,
      providerCalls: false,
      visualHiveRerun: false,
      requiresTrustedWorkflow: true,
      secretsPolicy: "names_only_values_redacted"
    },
    readiness: {
      canRunTrustedRepairWorkflow: blockedReasons.length === 0,
      blockedReasons,
      requiredApprovals: consumerSummary.readiness.requiredApprovals,
      requiredCommands: consumerSummary.readiness.requiredCommands
    },
    summary: {
      requestedRepairs: items.length,
      readyRepairs,
      blockedRepairs,
      plannedBranches: readyRepairs,
      plannedPullRequests: readyRepairs,
      plannedActions: plannedActions.length,
      blockedActions,
      externalCallsMade: 0
    },
    currentActions: {
      checkedOutCode: false,
      createdBranches: false,
      openedPullRequests: false,
      createdIssues: false,
      calledHiveApi: false,
      calledProviders: false,
      ranVisualHive: false,
      executedRepair: false
    },
    items
  }) as HiveTrustedRepairWorkflowDryRun;
  return dryRun;
}

export async function writeHiveTrustedRepairWorkflowDryRun(
  options: WriteHiveTrustedRepairWorkflowDryRunOptions
): Promise<WriteHiveTrustedRepairWorkflowDryRunResult> {
  const rootDir = path.resolve(options.rootDir);
  const dryRun = buildHiveTrustedRepairWorkflowDryRun(options);
  const markdown = renderHiveTrustedRepairWorkflowDryRunMarkdown(dryRun);
  await writeJson(resolveArtifact(rootDir, dryRun.outputArtifacts.dryRun), dryRun);
  await writeText(resolveArtifact(rootDir, dryRun.outputArtifacts.markdown), markdown);
  return { dryRun, markdown, paths: dryRun.outputArtifacts };
}

export function renderHiveTrustedRepairWorkflowDryRun(
  result: WriteHiveTrustedRepairWorkflowDryRunResult,
  format: "markdown" | "json" = "markdown"
): string {
  if (format === "json") return JSON.stringify(result.dryRun, null, 2);
  return [
    `Wrote ${result.paths.dryRun}`,
    `Wrote ${result.paths.markdown}`,
    "",
    `# Hive Trusted Repair Workflow Dry Run: ${result.dryRun.project}`,
    "",
    `- Status: ${result.dryRun.status}`,
    `- External calls made: ${result.dryRun.externalCallsMade}`,
    `- Can run trusted repair workflow: ${result.dryRun.readiness.canRunTrustedRepairWorkflow}`,
    `- Requested repairs: ${result.dryRun.summary.requestedRepairs}`,
    `- Ready repairs: ${result.dryRun.summary.readyRepairs}`,
    `- Planned branches: ${result.dryRun.summary.plannedBranches}`,
    `- Planned pull requests: ${result.dryRun.summary.plannedPullRequests}`,
    `- Planned actions: ${result.dryRun.summary.plannedActions}`,
    ...(result.dryRun.readiness.blockedReasons.length ? [`- Blocked reasons: ${result.dryRun.readiness.blockedReasons.join("; ")}`] : [])
  ].join("\n");
}

export function buildHiveModeComparison(options: BuildHiveModeComparisonOptions): { comparison: HiveModeComparison; exports: HiveExportArtifacts[]; markdown: string } {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const outputDir = normalizePath(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const modesDir = `${outputDir}/modes`;
  const modes = dedupeModes(options.modes?.length ? options.modes : DEFAULT_MODE_COMPARISON_MODES);
  const exports = modes.map((mode) =>
    buildHiveExportArtifacts({
      ...options,
      now: new Date(generatedAt),
      outputDir: `${modesDir}/${mode}`,
      hiveConfig: {
        ...(options.hiveConfig ?? {}),
        mode
      }
    })
  );
  const entries = exports.map((artifact): HiveModeComparisonEntry => modeComparisonEntry(artifact.bundle));
  const recommendation = recommendHiveMode(entries, outputDir);
  const comparison: HiveModeComparison = sanitizeValue({
    schemaVersion: "visual-hive.hive-mode-comparison.v1",
    generatedAt,
    project: options.evidencePacket.project,
    externalCallsMade: 0,
    sourceArtifacts: {
      evidencePacket: normalizePath(options.evidencePacketPath),
      handoffPacket: options.handoffPacketPath ? normalizePath(options.handoffPacketPath) : undefined
    },
    outputArtifacts: {
      comparison: `${outputDir}/mode-comparison.json`,
      markdown: `${outputDir}/mode-comparison.md`,
      modesDir
    },
    outputResource: catalogedOutputResource("comparison", `${outputDir}/mode-comparison.json`, "hive-mode-comparison"),
    modes: entries,
    recommendation,
    governance: {
      verdictAuthority: "visual_hive",
      defaultMode: "advisory_no_network",
      repairAuthority: "hive_may_open_pr_only_when_trusted_policy_allows",
      validationRequired: "visual_hive_must_rerun_after_repair",
      secretPolicy: "redacted_values_names_only"
    }
  }) as HiveModeComparison;
  return { comparison, exports, markdown: renderHiveModeComparisonMarkdown(comparison) };
}

export async function writeHiveModeComparison(options: WriteHiveModeComparisonOptions): Promise<WriteHiveModeComparisonResult> {
  const rootDir = path.resolve(options.rootDir);
  const comparisonArtifacts = buildHiveModeComparison(options);
  const writtenExports: WriteHiveExportResult[] = [];
  for (const artifact of comparisonArtifacts.exports) {
    writtenExports.push(
      await writeHiveExportArtifacts({
        ...options,
        now: new Date(comparisonArtifacts.comparison.generatedAt),
        outputDir: path.dirname(artifact.bundle.outputArtifacts.export),
        hiveConfig: {
          ...(options.hiveConfig ?? {}),
          mode: artifact.bundle.mode
        },
        rootDir
      })
    );
  }
  await writeJson(resolveArtifact(rootDir, comparisonArtifacts.comparison.outputArtifacts.comparison), comparisonArtifacts.comparison);
  await writeText(resolveArtifact(rootDir, comparisonArtifacts.comparison.outputArtifacts.markdown), comparisonArtifacts.markdown);
  return {
    comparison: comparisonArtifacts.comparison,
    exports: writtenExports,
    markdown: comparisonArtifacts.markdown,
    paths: comparisonArtifacts.comparison.outputArtifacts
  };
}

export function renderHiveModeComparisonSummary(result: WriteHiveModeComparisonResult, format: "markdown" | "json" = "markdown"): string {
  if (format === "json") return JSON.stringify(result.comparison, null, 2);
  return [
    `Wrote ${result.paths.comparison}`,
    `Wrote ${result.paths.markdown}`,
    "",
    renderHiveModeComparisonMarkdown(result.comparison)
  ].join("\n");
}

function modeComparisonEntry(bundle: HiveExportBundle): HiveModeComparisonEntry {
  return {
    mode: bundle.mode,
    status: bundle.status,
    outputDir: path.dirname(bundle.outputArtifacts.export).replaceAll("\\", "/"),
    exportPath: bundle.outputArtifacts.export,
    externalCallsMade: 0,
    summary: bundle.summary,
    blockedReasons: bundle.blockedReasons,
    emits: {
      issueContext: true,
      beads: bundle.summary.beads > 0,
      knowledgeFacts: bundle.summary.knowledgeFacts > 0,
      knowledgeGraph: bundle.summary.graphNodes > 0 || bundle.summary.graphEdges > 0,
      wikiVault: bundle.summary.knowledgeFacts > 0,
      repairWorkOrders: bundle.summary.repairWorkOrders > 0,
      agentPolicy: true
    },
    policy: {
      localPreviewAllowed: ["advisory", "measured", "repair_request"].includes(bundle.mode),
      trustedWorkflowRequired: bundle.mode === "guarded_repair" || bundle.mode === "full",
      verdictAuthority: "visual_hive",
      hiveAuthority: "advisory_or_guarded_repair"
    },
    recommendedUse: recommendedUseForMode(bundle.mode)
  };
}

function recommendHiveMode(entries: HiveModeComparisonEntry[], outputDir: string): HiveModeComparison["recommendation"] {
  const repair = entries.find((entry) => entry.mode === "repair_request" && entry.summary.repairWorkOrders > 0 && entry.status === "ready");
  if (repair) {
    return {
      mode: "repair_request",
      reason: "Deterministic evidence produced repair-ready work orders; use repair_request for a trusted Hive issue or repair lane.",
      nextCommand: `visual-hive hive export --dry-run --mode repair_request --output-dir ${outputDir}`
    };
  }
  const measured = entries.find((entry) => entry.mode === "measured" && (entry.summary.beads > 0 || entry.summary.knowledgeFacts > 0) && entry.status === "ready");
  if (measured) {
    return {
      mode: "measured",
      reason: "Evidence produced Hive Beads or knowledge facts but no guarded repair work orders; use measured mode for queueing and context.",
      nextCommand: `visual-hive hive export --dry-run --mode measured --output-dir ${outputDir}`
    };
  }
  return {
    mode: "advisory",
    reason: "No repair-ready or measured work was available; use advisory mode for issue context and policy documentation only.",
    nextCommand: `visual-hive hive export --dry-run --mode advisory --output-dir ${outputDir}`
  };
}

function recommendedUseForMode(mode: HiveAutomationMode): string {
  if (mode === "advisory") return "Use for the safest issue-context export when Hive should only summarize or route evidence.";
  if (mode === "measured") return "Use when Hive should receive Beads, facts, graph context, and wiki pages without repair authority.";
  if (mode === "repair_request") return "Use when deterministic evidence should become bounded repair work orders for a trusted PR-only lane.";
  if (mode === "guarded_repair") return "Use only in future trusted automation with branch isolation, human review policy, and rerun enforcement.";
  return "Reserved for future mature automation and blocked locally until governance is proven.";
}

function renderHiveModeComparisonMarkdown(comparison: HiveModeComparison): string {
  return sanitizeText(
    [
      `# Hive Export Mode Comparison: ${comparison.project}`,
      "",
      "- External calls made: 0",
      "- Verdict authority: Visual Hive",
      `- Recommended mode: ${comparison.recommendation.mode}`,
      `- Recommendation: ${comparison.recommendation.reason}`,
      `- Next command: \`${comparison.recommendation.nextCommand}\``,
      "",
      "| Mode | Status | Beads | Facts | Graph | Repair orders | Policy |",
      "| --- | --- | ---: | ---: | --- | ---: | --- |",
      ...comparison.modes.map((entry) =>
        [
          entry.mode,
          entry.status,
          String(entry.summary.beads),
          String(entry.summary.knowledgeFacts),
          `${entry.summary.graphNodes}/${entry.summary.graphEdges}`,
          String(entry.summary.repairWorkOrders),
          entry.policy.trustedWorkflowRequired ? "trusted workflow required" : "local dry-run preview"
        ].join(" | ")
      ).map((row) => `| ${row} |`),
      "",
      "## Guardrails",
      "",
      "- Visual Hive owns the deterministic verdict.",
      "- Hive exports are no-network by default.",
      "- Advisory, measured, and repair-request previews are local dry-run artifacts.",
      "- Guarded repair and full automation are visible policy states, but remain blocked until explicit trusted policy permits execution.",
      "- Secret values must never be copied into Hive artifacts."
    ].join("\n")
  ) + "\n";
}

function buildWorkSources(evidence: EvidencePacket, handoff?: HandoffPacket): HiveWorkSource[] {
  const workItems = handoff?.workItems.length ? handoff.workItems : fallbackWorkItems(evidence);
  return workItems.map((workItem) => ({
    workItem,
    contributions: evidence.evidenceContributions.filter((contribution) => workItem.evidenceKeys.includes(contribution.key))
  }));
}

function fallbackWorkItems(evidence: EvidencePacket): HandoffWorkItem[] {
  const actionable = evidence.evidenceContributions.filter((contribution) =>
    ["failed", "blocked"].includes(contribution.status) || contribution.kind === "mutation_survivor"
  );
  return actionable.slice(0, 12).map((contribution) => ({
    id: safeSlug(contribution.key),
    kind: contribution.kind === "mutation_survivor" || contribution.source === "mutation" ? "test_creation" : contribution.status === "blocked" ? "setup" : "repair",
    priority: contribution.status === "blocked" ? "critical" : contribution.gating ? "high" : "medium",
    title: titleForContribution(contribution),
    summary: contribution.reason,
    evidenceKeys: [contribution.key],
    artifacts: contribution.artifacts,
    suggestedNextSteps: suggestedStepsForContribution(contribution)
  }));
}

function buildBeads(context: HiveSourceContext, workSources: HiveWorkSource[]): HiveBead[] {
  const beads: HiveBead[] = workSources.map(({ workItem, contributions }) => {
    const beadId = `vh-${stableHash(workItem.id).slice(0, 12)}`;
    const firstContribution = contributions[0];
    return {
      id: beadId,
      title: workItem.title,
      type: beadTypeFor(workItem),
      status: workItem.kind === "setup" ? "blocked" : "open",
      priority: beadPriorityFor(workItem.priority),
      actor: actorFor(workItem, context),
      external_ref: `visual-hive://${context.evidence.project}/${workItem.id}`,
      metadata: compactRecord({
        visual_hive_project: context.evidence.project,
        visual_hive_verdict: context.evidence.verdictSummary.visualHiveVerdict,
        visual_hive_work_item_id: workItem.id,
        visual_hive_work_item_kind: workItem.kind,
        visual_hive_source: firstContribution?.source,
        visual_hive_contract_id: firstContribution?.contractId,
        visual_hive_target_id: firstContribution?.targetId,
        visual_hive_operator: firstContribution?.operator,
        visual_hive_mode: context.mode,
        artifact_count: String(workItem.artifacts.length)
      }),
      notes: renderBeadNotes(workItem),
      created_at: context.generatedAt,
      updated_at: context.generatedAt,
      depends_on: []
    };
  });
  const uxContext = context.handoff?.uxScoutContext;
  if (uxContext?.affectedFlows.length) {
    const flowIds = uxContext.affectedFlows.map((flow) => flow.id);
    const routes = dedupe(uxContext.affectedFlows.flatMap((flow) => flow.routes));
    beads.push({
      id: `vh-ux-${stableHash(`${context.evidence.project}:${flowIds.join(",")}`).slice(0, 12)}`,
      title: `[UX] Review affected flow${flowIds.length === 1 ? "" : "s"}: ${flowIds.join(", ")}`,
      type: "advisory",
      status: "open",
      priority: 2,
      actor: "ux-scout",
      external_ref: `visual-hive://ux-scout/${context.evidence.project}/${stableHash(flowIds.join(",")).slice(0, 12)}`,
      metadata: compactRecord({
        visual_hive_project: context.evidence.project,
        visual_hive_verdict: context.evidence.verdictSummary.visualHiveVerdict,
        visual_hive_source: "ux-scout-context",
        visual_hive_agent: "ux-scout",
        ux_scout_context: ".visual-hive/ux-scout-context.json",
        ux_scout_flow_ids: flowIds.join(","),
        ux_scout_routes: routes.join(","),
        ux_scout_changed_files: uxContext.changedFiles.join(","),
        visual_hive_mode: context.mode
      }),
      notes: renderUxScoutBeadNotes(uxContext),
      created_at: context.generatedAt,
      updated_at: context.generatedAt,
      depends_on: []
    });
  }
  return beads;
}

function buildKnowledgeFacts(context: HiveSourceContext, workSources: HiveWorkSource[], maxFacts: number): HiveKnowledgeFact[] {
  const facts: HiveKnowledgeFact[] = [];
  for (const { workItem, contributions } of workSources) {
    const firstContribution = contributions[0];
    facts.push({
      slug: safeSlug(`visual-hive-${workItem.id}`),
      title: factTitleFor(workItem, firstContribution),
      type: factTypeFor(workItem, firstContribution),
      layer: "project",
      confidence: confidenceFor(firstContribution),
      tags: factTagsFor(workItem, firstContribution, context),
      source: "visual-hive:evidence-packet",
      body: renderFactBody(workItem, contributions, context),
      relatedEvidenceKeys: workItem.evidenceKeys,
      artifacts: workItem.artifacts
    });
  }
  for (const layer of context.evidence.testingLayers.filter((layer) => layer.status === "missing" || layer.status === "partial").slice(0, 8)) {
    facts.push({
      slug: safeSlug(`visual-hive-testing-layer-${layer.id}-${layer.status}`),
      title: `${layer.name} is ${layer.status}`,
      type: "test_scaffold",
      layer: "project",
      confidence: 0.78,
      tags: ["visual-hive", "testing-layer", `layer-${layer.id}`, layer.status],
      source: "visual-hive:testing-layers",
      body: sanitizeText([`Layer ${layer.id}: ${layer.name}`, "", ...layer.gaps.map((gap) => `- ${gap}`)].join("\n")),
      relatedEvidenceKeys: [`testing_layer.${layer.id}.${layer.status}`],
      artifacts: layer.evidence
    });
  }
  facts.push({
    slug: "visual-hive-verdict-policy",
    title: "Visual Hive remains the deterministic verdict authority",
    type: "decision",
    layer: "project",
    confidence: 1,
    tags: ["visual-hive", "policy", "verdict", "hive"],
    source: "visual-hive:hive-export",
    body: "Hive may route, advise, and repair in trusted modes, but only a fresh Visual Hive deterministic verdict can close the finding.",
    relatedEvidenceKeys: ["visual_hive.policy.verdict_authority"],
    artifacts: [".visual-hive/evidence-packet.json", ".visual-hive/verdict.json"]
  });
  for (const provider of context.evidence.providers.filter((entry) => entry.upload || entry.status !== "skipped").slice(0, 8)) {
    facts.push({
      slug: safeSlug(`visual-hive-provider-${provider.providerId}`),
      title: `${provider.providerId} provider evidence is ${provider.status}`,
      type: "integration",
      layer: "project",
      confidence: provider.upload ? 0.86 : 0.72,
      tags: dedupe(
        ["visual-hive", "provider", provider.providerId, provider.status, provider.upload?.status ? `upload:${provider.upload.status}` : undefined].filter(
          (tag): tag is string => Boolean(tag)
        )
      ),
      source: "visual-hive:provider-evidence",
      body: renderProviderFactBody(provider),
      relatedEvidenceKeys: [`provider.normalized_provider_result.${provider.providerId}`, `provider.provider_upload.${provider.providerId}`],
      artifacts: [provider.upload?.manifestPath, provider.upload?.uploadDirectory, ".visual-hive/provider-results.json"].filter(
        (artifact): artifact is string => Boolean(artifact)
      )
    });
  }
  return dedupeFacts(facts).slice(0, Math.max(0, maxFacts));
}

function providerEvidenceFor(evidence: EvidencePacket): HiveProviderEvidenceSummary[] {
  return evidence.providers.map((provider) => ({
    providerId: provider.providerId,
    status: provider.status,
    deterministicRole: provider.deterministicRole,
    uploadStatus: provider.upload?.status,
    externalCallsMade: provider.upload?.externalCallsMade ?? 0,
    stagedArtifacts: provider.upload?.stagedArtifacts,
    uploadedArtifacts: provider.upload?.uploadedArtifacts,
    manifestPath: provider.upload?.manifestPath,
    uploadDirectory: provider.upload?.uploadDirectory,
    providerUrl: provider.upload?.providerUrl,
    blockedReasons: provider.upload?.blockedReasons ?? provider.externalUploadBlockedReasons ?? []
  }));
}

function renderProviderFactBody(provider: EvidencePacket["providers"][number]): string {
  return sanitizeText(
    [
      `${provider.label} provider status is ${provider.status}.`,
      `Deterministic role: ${provider.deterministicRole}.`,
      `Artifact count: ${provider.artifactCount}.`,
      provider.upload
        ? `Upload status: ${provider.upload.status}; external calls: ${provider.upload.externalCallsMade}; staged: ${provider.upload.stagedArtifacts}; uploaded: ${provider.upload.uploadedArtifacts}.`
        : "No provider upload evidence is available.",
      provider.upload?.manifestPath ? `Manifest: ${provider.upload.manifestPath}.` : "",
      provider.upload?.blockedReasons?.length ? `Blocked reasons: ${provider.upload.blockedReasons.join("; ")}.` : "",
      "Provider output remains policy-gated and does not override the Visual Hive deterministic verdict by default."
    ]
      .filter(Boolean)
      .join("\n")
  );
}

function buildRepairWorkOrders(context: HiveSourceContext, workSources: HiveWorkSource[], beads: HiveBead[]): HiveRepairWorkOrder[] {
  const beadByWorkItem = new Map<string, HiveBead>();
  for (let index = 0; index < workSources.length; index += 1) {
    const bead = beads[index];
    if (bead) beadByWorkItem.set(workSources[index]!.workItem.id, bead);
  }
  return workSources
    .filter(({ workItem }) => workItem.kind === "repair" || workItem.kind === "test_creation" || workItem.kind === "setup")
    .map(({ workItem, contributions }) => ({
      id: `hive-repair-${safeSlug(workItem.id)}`,
      actor: actorFor(workItem, context),
      title: workItem.title,
      objective: repairObjectiveFor(workItem),
      sourceBeadIds: beadByWorkItem.get(workItem.id)?.id ? [beadByWorkItem.get(workItem.id)!.id] : [],
      evidenceKeys: workItem.evidenceKeys,
      likelyFiles: likelyFilesFor(context, contributions),
      artifacts: workItem.artifacts,
      reproductionCommands: context.evidence.deterministicReport?.failedContracts
        .map((contract) => contract.reproductionCommand)
        .filter((command): command is string => Boolean(command)) ?? context.evidence.deterministicReport?.reproductionCommands ?? [],
      acceptanceCriteria: [
        "Visual Hive verdict passes after repair.",
        "The repair is submitted as a branch or pull request, not a direct write to main.",
        "No secret values are read or printed.",
        "Protected targets are not executed from untrusted PR code."
      ],
      allowedActions: allowedRepairActionsFor(workItem),
      forbiddenActions: forbiddenRepairActions(),
      maxAttempts: context.config.repair.maxAttempts,
      branchPrefix: context.config.repair.branchPrefix,
      prOnly: context.config.repair.prOnly,
      requireHumanReview: context.config.repair.requireHumanReview,
      rerunVisualHive: context.config.repair.rerunVisualHive
    }));
}

function buildKnowledgeGraph(
  context: HiveSourceContext,
  beads: HiveBead[],
  facts: HiveKnowledgeFact[],
  repairWorkOrders: HiveRepairWorkOrder[]
): HiveKnowledgeGraph {
  const nodes = new Map<string, HiveGraphNode>();
  const edges: HiveGraphEdge[] = [];
  const addNode = (node: HiveGraphNode) => nodes.set(node.id, node);
  const addEdge = (from: string, to: string, predicate: HiveGraphEdge["predicate"]) => {
    if (nodes.has(from) && nodes.has(to)) edges.push({ from, to, predicate });
  };
  addNode({ id: "visual-hive-verdict", slug: "visual-hive-verdict", title: `Visual Hive ${context.evidence.verdictSummary.visualHiveVerdict}`, type: "verdict", tags: ["visual-hive", "verdict"] });
  for (const contribution of context.evidence.evidenceContributions.slice(0, 80)) {
    addNode({
      id: `evidence:${safeSlug(contribution.key)}`,
      slug: safeSlug(contribution.key),
      title: contribution.key,
      type: `evidence:${contribution.source}:${contribution.kind}`,
      tags: ["evidence", contribution.source, contribution.kind, contribution.status],
      artifactPath: contribution.artifacts[0]
    });
    addEdge(`evidence:${safeSlug(contribution.key)}`, "visual-hive-verdict", "derived_from");
  }
  for (const bead of beads) {
    addNode({ id: `bead:${bead.id}`, slug: bead.id, title: bead.title, type: `bead:${bead.type}`, tags: ["bead", bead.actor, String(bead.priority)] });
    addEdge(`bead:${bead.id}`, "visual-hive-verdict", "derived_from");
  }
  for (const fact of facts) {
    addNode({
      id: `fact:${fact.slug}`,
      slug: fact.slug,
      title: fact.title,
      type: `fact:${fact.type}`,
      layer: fact.layer,
      confidence: fact.confidence,
      tags: fact.tags,
      artifactPath: fact.artifacts[0]
    });
    for (const key of fact.relatedEvidenceKeys) {
      addEdge(`fact:${fact.slug}`, `evidence:${safeSlug(key)}`, "derived_from");
    }
  }
  for (const workOrder of repairWorkOrders) {
    addNode({ id: `repair:${workOrder.id}`, slug: workOrder.id, title: workOrder.title, type: "repair_work_order", tags: ["repair", workOrder.actor] });
    for (const beadId of workOrder.sourceBeadIds) addEdge(`repair:${workOrder.id}`, `bead:${beadId}`, "depends_on");
    for (const key of workOrder.evidenceKeys) addEdge(`repair:${workOrder.id}`, `evidence:${safeSlug(key)}`, "derived_from");
  }
  for (const fact of facts) {
    for (const bead of beads) {
      if (fact.relatedEvidenceKeys.some((key) => bead.metadata.visual_hive_work_item_id?.includes(safeSlug(key)) || bead.notes.includes(key))) {
        addEdge(`bead:${bead.id}`, `fact:${fact.slug}`, "related_to");
      }
    }
  }
  return { schemaVersion: "visual-hive.hive-knowledge-graph.v1", nodes: [...nodes.values()], edges: dedupeEdges(edges) };
}

function buildWikiIndex(
  context: HiveSourceContext,
  facts: HiveKnowledgeFact[],
  wikiPages: Array<{ slug: string; path: string; content: string }>,
  wikiVaultDir: string
): HiveWikiIndex {
  const pageBySlug = new Map(wikiPages.map((page) => [page.slug, page]));
  return {
    schemaVersion: "visual-hive.hive-wiki-index.v1",
    generatedAt: context.generatedAt,
    project: context.evidence.project,
    externalCallsMade: 0,
    wikiVaultDir,
    pages: facts
      .map((fact) => {
        const page = pageBySlug.get(fact.slug);
        if (!page) return undefined;
        return {
          slug: fact.slug,
          title: fact.title,
          type: fact.type,
          source: fact.source,
          path: page.path,
          tags: fact.tags,
          relatedEvidenceKeys: fact.relatedEvidenceKeys,
          artifacts: fact.artifacts
        };
      })
      .filter((page): page is HiveWikiIndex["pages"][number] => Boolean(page))
  };
}

function buildAgentPolicy(context: HiveSourceContext): HiveAgentPolicy {
  const repairMode = shouldEmitRepairArtifacts(context.mode, context.config);
  return {
    schemaVersion: "visual-hive.hive-agent-policy.v1",
    mode: context.mode,
    acmmLevel: context.config.acmmLevel,
    enabled: context.config.enabled,
    externalCallsMade: 0,
    verdictAuthority: "visual_hive",
    hiveAuthority: "advisory_or_guarded_repair",
    repair: context.config.repair,
    allowedActions: repairMode
      ? ["read_sanitized_evidence", "create_repair_branch", "edit_source_or_tests", "open_pull_request", "request_visual_hive_rerun"]
      : ["read_sanitized_evidence", "summarize_failures", "draft_issue_comment", "recommend_tests"],
    forbiddenActions: forbiddenRepairActions(),
    trustedWorkflowRequiredFor: ["github_issue_creation", "hive_bead_creation", "agent_repair_execution", "protected_target_execution", "auto_merge"],
    finalValidation: {
      required: true,
      command: "visual-hive pipeline --mode pr --ci",
      passFailOwnedBy: "visual_hive_verdict_engine"
    }
  };
}

function renderHiveIssueContext(bundle: HiveExportBundle, context: HiveSourceContext, workSources: HiveWorkSource[]): string {
  const repairMessage = bundle.repairWorkOrders.length
    ? "Hive may attempt a repair PR under trusted policy; Visual Hive must re-run before merge."
    : "Hive may summarize, route, and recommend next tests; repair execution is not enabled for this export.";
  return sanitizeText(
    [
      `# Hive Agent Work Order: ${bundle.project}`,
      "",
      "<!-- visual-hive-hive-native-export -->",
      "",
      "## Summary",
      "",
      `- Visual Hive verdict: ${context.evidence.verdictSummary.visualHiveVerdict}`,
      `- Hive mode: ${bundle.mode}`,
      `- ACMM level: ${bundle.acmmLevel}`,
      `- External calls made: ${bundle.externalCallsMade}`,
      `- Beads: ${bundle.summary.beads}`,
      `- Knowledge facts: ${bundle.summary.knowledgeFacts}`,
      `- Repair work orders: ${bundle.summary.repairWorkOrders}`,
      `- Provider evidence records: ${bundle.providerEvidence.length}`,
      `- Policy: ${repairMessage}`,
      "",
      "## Gating Evidence",
      "",
      ...listEvidence(context.evidence.evidenceContributions.filter((contribution) => contribution.gating).slice(0, 16)),
      "",
      "## Beads",
      "",
      ...(bundle.beads.length ? bundle.beads.map((bead) => `- [${bead.id}] p${bead.priority} ${bead.actor}/${bead.type}: ${bead.title}`) : ["- No Hive beads emitted in advisory mode."]),
      "",
      "## Knowledge Facts",
      "",
      ...(bundle.knowledgeFacts.length
        ? bundle.knowledgeFacts.slice(0, 12).map((fact) => `- ${fact.type}: ${fact.title} (${fact.slug})`)
        : ["- No Hive knowledge facts emitted in advisory mode."]),
      "",
      "## Provider Evidence",
      "",
      ...(bundle.providerEvidence.length
        ? bundle.providerEvidence.map(
            (provider) =>
              `- ${provider.providerId}: status=${provider.status}; upload=${provider.uploadStatus ?? "none"}; calls=${provider.externalCallsMade}; artifacts=${provider.stagedArtifacts ?? provider.uploadedArtifacts ?? 0}`
          )
        : ["- No optional provider evidence available."]),
      "",
      "## Repair Work Orders",
      "",
      ...(bundle.repairWorkOrders.length
        ? bundle.repairWorkOrders.map((order) => `- ${order.id}: ${order.objective}`)
        : ["- No repair work orders emitted."]),
      "",
      "## Reproduction Commands",
      "",
      ...(context.evidence.deterministicReport?.reproductionCommands?.length
        ? context.evidence.deterministicReport.reproductionCommands.map((command) => `- \`${command}\``)
        : ["- See `.visual-hive/evidence-packet.json`."]),
      "",
      "## Suggested Files To Inspect",
      "",
      ...suggestedFiles(context, workSources).map((file) => `- ${file}`),
      "",
      "## Guardrails",
      "",
      "- Visual Hive owns the final deterministic verdict.",
      "- Hive agents may fix issues only in trusted repair modes.",
      "- A Hive repair must create a branch or pull request and Visual Hive must pass afterward.",
      "- No secret values may be read, printed, or copied into issues.",
      "- Protected targets must not run from untrusted PR code."
    ].join("\n")
  ) + "\n";
}

function wikiPageFor(fact: HiveKnowledgeFact, wikiVaultDir: string): { slug: string; path: string; content: string } {
  const tags = fact.tags.map((tag) => `  - ${yamlString(tag)}`).join("\n");
  const evidence = fact.relatedEvidenceKeys.map((key) => `  - ${yamlString(key)}`).join("\n");
  const artifacts = fact.artifacts.map((artifact) => `  - ${yamlString(artifact)}`).join("\n");
  const content = sanitizeText(
    [
      "---",
      `title: ${yamlString(fact.title)}`,
      `type: ${fact.type}`,
      `layer: ${fact.layer}`,
      `confidence: ${fact.confidence}`,
      `source: ${yamlString(fact.source)}`,
      "tags:",
      tags || "  - visual-hive",
      "relatedEvidenceKeys:",
      evidence || "  - visual_hive",
      "artifacts:",
      artifacts || "  - .visual-hive/evidence-packet.json",
      "---",
      "",
      fact.body,
      ""
    ].join("\n")
  );
  return { slug: fact.slug, path: `${wikiVaultDir}/${fact.slug}.md`, content };
}

function guardedRepairPreviewPaths(outputDir: string): HiveGuardedRepairPreview["outputArtifacts"] {
  return {
    preview: `${outputDir}/guarded-repair-preview.json`,
    markdown: `${outputDir}/guarded-repair-preview.md`
  };
}

function guardedRepairWorkOrder(order: HiveRepairWorkOrder): HiveGuardedRepairPreviewWorkOrder {
  const blockedReasons: string[] = [];
  if (!order.prOnly) blockedReasons.push("Work order must be PR-only before guarded repair can execute.");
  if (!order.requireHumanReview) blockedReasons.push("Work order must require human review before guarded repair can execute.");
  if (!order.rerunVisualHive) blockedReasons.push("Work order must require a Visual Hive rerun before completion.");
  if (!order.allowedActions.includes("create_branch") && !order.allowedActions.includes("create_repair_branch")) {
    blockedReasons.push("Work order must allow branch creation instead of direct writes.");
  }
  if (!order.forbiddenActions.includes("decide_visual_hive_verdict")) {
    blockedReasons.push("Work order must forbid non-Visual-Hive verdict authority.");
  }
  if (!order.forbiddenActions.includes("push_directly_to_main")) {
    blockedReasons.push("Work order must forbid direct pushes to main.");
  }
  return {
    id: order.id,
    title: order.title,
    actor: order.actor,
    objective: order.objective,
    branchName: `${order.branchPrefix}${safeSlug(order.id).slice(0, 48)}`,
    maxAttempts: order.maxAttempts,
    prOnly: order.prOnly,
    requireHumanReview: order.requireHumanReview,
    rerunVisualHive: order.rerunVisualHive,
    likelyFiles: order.likelyFiles,
    artifacts: order.artifacts,
    reproductionCommands: order.reproductionCommands,
    acceptanceCriteria: order.acceptanceCriteria,
    allowedActions: order.allowedActions,
    forbiddenActions: order.forbiddenActions,
    blockedReasons: dedupe(blockedReasons)
  };
}

function guardedRepairPreviewBlockedReasons(bundle: HiveExportBundle, workOrders: HiveGuardedRepairPreviewWorkOrder[]): string[] {
  const reasons = [...bundle.blockedReasons];
  if (bundle.externalCallsMade !== 0) reasons.push("Hive guarded repair preview must be generated from no-network artifacts.");
  if (bundle.mode === "full") reasons.push("Full Hive automation cannot be used as a guarded repair preview source.");
  if (bundle.summary.repairWorkOrders === 0 || workOrders.length === 0) {
    reasons.push("No repair work orders are available. Run `visual-hive hive export --dry-run --mode repair_request` after deterministic evidence exists.");
  }
  if (!bundle.agentPolicy.repair.prOnly) reasons.push("Hive repair policy must be PR-only.");
  if (!bundle.agentPolicy.repair.requireHumanReview) reasons.push("Hive repair policy must require human review.");
  if (!bundle.agentPolicy.repair.rerunVisualHive) reasons.push("Hive repair policy must require rerunning Visual Hive before completion.");
  if (!bundle.agentPolicy.finalValidation.required || bundle.agentPolicy.finalValidation.passFailOwnedBy !== "visual_hive_verdict_engine") {
    reasons.push("Hive repair policy must require final validation by the Visual Hive verdict engine.");
  }
  if (!bundle.agentPolicy.forbiddenActions.includes("decide_visual_hive_verdict")) {
    reasons.push("Hive agent policy must forbid agents from deciding the Visual Hive verdict.");
  }
  if (!bundle.agentPolicy.forbiddenActions.includes("auto_merge_without_visual_hive_pass")) {
    reasons.push("Hive agent policy must forbid auto-merge without a passing Visual Hive rerun.");
  }
  reasons.push(...workOrders.flatMap((order) => order.blockedReasons.map((reason) => `${order.id}: ${reason}`)));
  return dedupe(reasons);
}

function guardedRepairApprovals(bundle: HiveExportBundle): string[] {
  return dedupe([
    "trusted workflow or maintainer must request repair execution",
    bundle.agentPolicy.repair.requireHumanReview ? "human review before merge" : undefined,
    "Visual Hive verdict must pass after repair",
    "secret-bearing or protected targets may only run in trusted scheduled/manual lanes"
  ].filter((value): value is string => Boolean(value)));
}

function renderHiveGuardedRepairPreviewMarkdown(preview: HiveGuardedRepairPreview): string {
  return sanitizeText(
    [
      `# Hive Guarded Repair Preview: ${preview.project}`,
      "",
      "<!-- visual-hive-hive-guarded-repair-preview -->",
      "",
      "## Summary",
      "",
      `- Status: ${preview.status}`,
      `- External calls made: ${preview.externalCallsMade}`,
      `- Can request guarded repair: ${preview.readiness.canRequestGuardedRepair}`,
      `- Repair work orders: ${preview.summary.repairWorkOrders}`,
      `- Ready work orders: ${preview.summary.readyWorkOrders}`,
      `- Blocked work orders: ${preview.summary.blockedWorkOrders}`,
      "",
      "## Policy",
      "",
      "- Visual Hive owns the final deterministic verdict.",
      "- This artifact is preview-only and executes no repair.",
      `- Pull request only: ${preview.policy.pullRequestOnly}`,
      `- Human review required: ${preview.policy.humanReviewRequired}`,
      `- Visual Hive rerun required: ${preview.policy.visualHiveRerunRequired}`,
      "- Protected targets must not run from untrusted PR code.",
      "- Secret values are redacted; only required secret names may appear.",
      "",
      "## Blocked Reasons",
      "",
      ...(preview.readiness.blockedReasons.length ? preview.readiness.blockedReasons.map((reason) => `- ${reason}`) : ["- None"]),
      "",
      "## Required Approvals",
      "",
      ...preview.readiness.requiredApprovals.map((approval) => `- ${approval}`),
      "",
      "## Required Commands",
      "",
      ...preview.readiness.requiredCommands.map((command) => `- \`${command}\``),
      "",
      "## Work Orders",
      "",
      ...(preview.workOrders.length
        ? preview.workOrders.map((order) =>
            [
              `### ${order.id}`,
              "",
              `- Actor: ${order.actor}`,
              `- Branch: \`${order.branchName}\``,
              `- Objective: ${order.objective}`,
              `- Max attempts: ${order.maxAttempts}`,
              `- Blocked: ${order.blockedReasons.length ? order.blockedReasons.join("; ") : "no"}`,
              "- Acceptance criteria:",
              ...order.acceptanceCriteria.map((criterion) => `  - ${criterion}`),
              "- Likely files:",
              ...(order.likelyFiles.length ? order.likelyFiles.map((file) => `  - ${file}`) : ["  - See evidence packet."])
            ].join("\n")
          )
        : ["No repair work orders are available."])
    ].join("\n")
  ) + "\n";
}

function repairRequestEnvelopePaths(outputDir: string): HiveRepairRequestEnvelope["outputArtifacts"] {
  return {
    envelope: `${outputDir}/repair-request-envelope.json`,
    markdown: `${outputDir}/repair-request-envelope.md`
  };
}

function repairRequestEnvelopeItem(order: HiveGuardedRepairPreviewWorkOrder, preview: HiveGuardedRepairPreview): HiveRepairRequestEnvelopeItem {
  return {
    id: order.id,
    title: order.title,
    actor: order.actor,
    objective: order.objective,
    branchName: order.branchName,
    allowedFiles: order.likelyFiles,
    artifacts: order.artifacts,
    reproductionCommands: order.reproductionCommands,
    acceptanceCriteria: order.acceptanceCriteria,
    allowedActions: order.allowedActions,
    forbiddenActions: order.forbiddenActions,
    maxAttempts: order.maxAttempts,
    requireHumanReview: order.requireHumanReview,
    finalValidationCommand: preview.readiness.requiredCommands[0] ?? "visual-hive pipeline --mode pr --ci",
    blockedReasons: order.blockedReasons
  };
}

function repairRequestEnvelopeBlockedReasons(preview: HiveGuardedRepairPreview, requests: HiveRepairRequestEnvelopeItem[]): string[] {
  const reasons = [...preview.readiness.blockedReasons];
  if (preview.externalCallsMade !== 0) reasons.push("Repair request envelope must be generated from no-network guarded preview artifacts.");
  if (preview.status !== "ready") reasons.push("Guarded repair preview is not ready.");
  if (!preview.readiness.canRequestGuardedRepair) reasons.push("Guarded repair preview does not allow a guarded repair request.");
  if (requests.length === 0) reasons.push("No guarded repair work orders are available for a trusted repair request.");
  if (preview.policy.verdictAuthority !== "visual_hive") reasons.push("Visual Hive must remain the verdict authority.");
  if (preview.policy.repairExecution !== "preview_only_no_execution") reasons.push("Guarded preview must not execute repair.");
  if (!preview.policy.branchIsolationRequired) reasons.push("Repair request requires branch isolation.");
  if (!preview.policy.pullRequestOnly) reasons.push("Repair request must be pull-request only.");
  if (!preview.policy.humanReviewRequired) reasons.push("Repair request must require human review.");
  if (!preview.policy.visualHiveRerunRequired) reasons.push("Repair request must require a Visual Hive rerun.");
  if (preview.policy.externalNetworkCalls !== false) reasons.push("Repair request envelope must remain no-network.");
  reasons.push(...requests.flatMap((request) => request.blockedReasons.map((reason) => `${request.id}: ${reason}`)));
  return dedupe(reasons);
}

function repairBranchPrefix(preview: HiveGuardedRepairPreview): string {
  const firstOrder = preview.workOrders.find((order) => order.branchName);
  const firstBranch = firstOrder?.branchName;
  if (!firstBranch) return "hive/visual-hive-";
  const slug = safeSlug(firstOrder.id).slice(0, 48);
  return firstBranch.endsWith(slug) ? firstBranch.slice(0, -slug.length) : "hive/visual-hive-";
}

function stableDedupeKey(project: string, value: string): string {
  return safeSlug(`${project}-${value}`).slice(0, 96) || "visual-hive-repair-request";
}

function renderHiveRepairRequestEnvelopeMarkdown(envelope: HiveRepairRequestEnvelope): string {
  return sanitizeText(
    [
      `# Hive Repair Request Envelope: ${envelope.project}`,
      "",
      "<!-- visual-hive-hive-repair-request-envelope -->",
      "",
      "## Summary",
      "",
      `- Status: ${envelope.status}`,
      `- External calls made: ${envelope.externalCallsMade}`,
      `- Can open trusted repair request: ${envelope.readiness.canOpenTrustedRepairRequest}`,
      `- Repair requests: ${envelope.summary.repairRequests}`,
      `- Ready requests: ${envelope.summary.readyRequests}`,
      `- Blocked requests: ${envelope.summary.blockedRequests}`,
      `- Dedupe key: ${envelope.github.dedupeKey}`,
      "",
      "## Trusted Workflow Policy",
      "",
      "- Visual Hive owns the final deterministic verdict.",
      "- This envelope requests trusted repair work but does not execute repair.",
      "- A trusted workflow or maintainer must create the branch or pull request.",
      `- Branch prefix: \`${envelope.github.branchPrefix}\``,
      `- Pull request only: ${envelope.policy.pullRequestOnly}`,
      `- Human review required: ${envelope.policy.humanReviewRequired}`,
      `- Visual Hive rerun required: ${envelope.policy.visualHiveRerunRequired}`,
      "- Hive, LLMs, MCP tools, and agents may repair under policy; they do not decide the Visual Hive verdict.",
      "",
      "## Blocked Reasons",
      "",
      ...(envelope.readiness.blockedReasons.length ? envelope.readiness.blockedReasons.map((reason) => `- ${reason}`) : ["- None"]),
      "",
      "## Required Commands",
      "",
      ...envelope.readiness.requiredCommands.map((command) => `- \`${command}\``),
      "",
      "## Requests",
      "",
      ...(envelope.requests.length
        ? envelope.requests.map((request) =>
            [
              `### ${request.id}`,
              "",
              `- Title: ${request.title}`,
              `- Actor: ${request.actor}`,
              `- Branch: \`${request.branchName}\``,
              `- Objective: ${request.objective}`,
              `- Final validation: \`${request.finalValidationCommand}\``,
              `- Blocked: ${request.blockedReasons.length ? request.blockedReasons.join("; ") : "no"}`,
              "- Allowed files:",
              ...(request.allowedFiles.length ? request.allowedFiles.map((file) => `  - ${file}`) : ["  - See Evidence Packet and Handoff Packet."]),
              "- Acceptance criteria:",
              ...request.acceptanceCriteria.map((criterion) => `  - ${criterion}`)
            ].join("\n")
          )
        : ["No trusted repair requests are available."])
    ].join("\n")
  ) + "\n";
}

function trustedRepairConsumerSummaryPaths(outputDir: string): HiveTrustedRepairConsumerSummary["outputArtifacts"] {
  return {
    summary: `${outputDir}/trusted-repair-consumer-summary.json`,
    markdown: `${outputDir}/trusted-repair-consumer-summary.md`
  };
}

function trustedRepairConsumerSummaryItem(request: HiveRepairRequestEnvelopeItem, envelope: HiveRepairRequestEnvelope): HiveTrustedRepairConsumerSummaryItem {
  return {
    id: request.id,
    title: request.title,
    actor: request.actor,
    status: request.blockedReasons.length ? "blocked" : "ready",
    branchName: request.branchName,
    pullRequestTitle: `${envelope.github.pullRequestTitlePrefix} ${request.title}`,
    labels: envelope.github.labels,
    allowedFiles: request.allowedFiles,
    artifacts: request.artifacts,
    reproductionCommands: request.reproductionCommands,
    acceptanceCriteria: request.acceptanceCriteria,
    finalValidationCommand: request.finalValidationCommand,
    blockedReasons: request.blockedReasons
  };
}

function trustedRepairConsumerSummaryBlockedReasons(envelope: HiveRepairRequestEnvelope, items: HiveTrustedRepairConsumerSummaryItem[]): string[] {
  const reasons = [...envelope.readiness.blockedReasons];
  if (envelope.externalCallsMade !== 0) reasons.push("Trusted repair consumer summary must be generated from no-network repair request artifacts.");
  if (envelope.status !== "ready") reasons.push("Repair request envelope is not ready.");
  if (!envelope.readiness.canOpenTrustedRepairRequest) reasons.push("Repair request envelope does not allow a trusted repair workflow to start.");
  if (items.length === 0) reasons.push("No trusted repair request items are available to consume.");
  if (envelope.policy.verdictAuthority !== "visual_hive") reasons.push("Visual Hive must remain the verdict authority.");
  if (envelope.policy.requestExecution !== "trusted_workflow_request_only") reasons.push("Repair request envelope must remain trusted-workflow-only.");
  if (envelope.policy.repairExecution !== "not_executed_by_visual_hive") reasons.push("Visual Hive must not execute repair.");
  if (!envelope.policy.requiresTrustedWorkflow) reasons.push("Trusted repair consumer requires a trusted workflow.");
  if (!envelope.policy.branchIsolationRequired) reasons.push("Trusted repair consumer requires branch isolation.");
  if (!envelope.policy.pullRequestOnly) reasons.push("Trusted repair consumer requires pull-request-only repair.");
  if (!envelope.policy.humanReviewRequired) reasons.push("Trusted repair consumer requires human review.");
  if (!envelope.policy.visualHiveRerunRequired) reasons.push("Trusted repair consumer requires a Visual Hive rerun.");
  if (envelope.policy.externalNetworkCalls !== false) reasons.push("Trusted repair consumer summary must remain no-network.");
  reasons.push(...items.flatMap((item) => item.blockedReasons.map((reason) => `${item.id}: ${reason}`)));
  return dedupe(reasons);
}

function renderHiveTrustedRepairConsumerSummaryMarkdown(summary: HiveTrustedRepairConsumerSummary): string {
  return sanitizeText(
    [
      `# Hive Trusted Repair Consumer Summary: ${summary.project}`,
      "",
      "<!-- visual-hive-hive-trusted-repair-consumer-summary -->",
      "",
      "## Summary",
      "",
      `- Status: ${summary.status}`,
      `- External calls made: ${summary.externalCallsMade}`,
      `- Can start trusted repair workflow: ${summary.readiness.canStartTrustedRepairWorkflow}`,
      `- Requested repairs: ${summary.summary.requestedRepairs}`,
      `- Ready repairs: ${summary.summary.readyRepairs}`,
      `- Blocked repairs: ${summary.summary.blockedRepairs}`,
      `- Branches that a future trusted workflow would create: ${summary.summary.branchesToCreate}`,
      `- Pull requests that a future trusted workflow would open: ${summary.summary.pullRequestsToOpen}`,
      "",
      "## Dry-run Consumer Policy",
      "",
      "- Visual Hive owns the final deterministic verdict.",
      "- This summary consumes the repair request envelope but does not execute repair.",
      `- Consumer execution: ${summary.policy.consumerExecution}`,
      `- Repair execution: ${summary.policy.repairExecution}`,
      `- Checkout performed now: ${summary.policy.checkoutCode}`,
      `- Branch creation performed now: ${summary.policy.branchCreation}`,
      `- Pull request creation performed now: ${summary.policy.pullRequestCreation}`,
      `- Issue creation performed now: ${summary.policy.issueCreation}`,
      `- Hive network calls performed now: ${summary.policy.hiveNetworkCalls}`,
      `- Provider calls performed now: ${summary.policy.providerCalls}`,
      `- Visual Hive rerun performed now: ${summary.policy.visualHiveRerun}`,
      "",
      "## Blocked Reasons",
      "",
      ...(summary.readiness.blockedReasons.length ? summary.readiness.blockedReasons.map((reason) => `- ${reason}`) : ["- None"]),
      "",
      "## Required Commands",
      "",
      ...summary.readiness.requiredCommands.map((command) => `- \`${command}\``),
      "",
      "## Repair Items",
      "",
      ...(summary.items.length
        ? summary.items.map((item) =>
            [
              `### ${item.id}`,
              "",
              `- Status: ${item.status}`,
              `- Title: ${item.title}`,
              `- Actor: ${item.actor}`,
              `- Branch: \`${item.branchName}\``,
              `- Pull request title: ${item.pullRequestTitle}`,
              `- Final validation: \`${item.finalValidationCommand}\``,
              `- Blocked: ${item.blockedReasons.length ? item.blockedReasons.join("; ") : "no"}`,
              "- Labels:",
              ...item.labels.map((label) => `  - ${label}`),
              "- Allowed files:",
              ...(item.allowedFiles.length ? item.allowedFiles.map((file) => `  - ${file}`) : ["  - See Evidence Packet and Handoff Packet."]),
              "- Acceptance criteria:",
              ...item.acceptanceCriteria.map((criterion) => `  - ${criterion}`)
            ].join("\n")
          )
        : ["No trusted repair items are available."])
    ].join("\n")
  ) + "\n";
}

function trustedRepairWorkflowDryRunPaths(outputDir: string): HiveTrustedRepairWorkflowDryRun["outputArtifacts"] {
  return {
    dryRun: `${outputDir}/trusted-repair-workflow-dry-run.json`,
    markdown: `${outputDir}/trusted-repair-workflow-dry-run.md`
  };
}

function trustedRepairWorkflowDryRunItem(
  item: HiveTrustedRepairConsumerSummaryItem,
  summary: HiveTrustedRepairConsumerSummary
): HiveTrustedRepairWorkflowDryRunItem {
  const blockedReasons = [...item.blockedReasons];
  if (summary.status !== "ready") blockedReasons.push("Trusted repair consumer summary is not ready.");
  if (!summary.readiness.canStartTrustedRepairWorkflow) blockedReasons.push("Trusted repair consumer summary does not allow workflow start.");
  const status: HiveTrustedRepairWorkflowDryRunItem["status"] = blockedReasons.length ? "blocked" : "ready";
  const actionStatus: HiveTrustedRepairWorkflowDryRunAction["status"] = status === "ready" ? "planned" : "blocked";
  const actionBlockedReasons = status === "ready" ? [] : dedupe(blockedReasons);
  const action = (
    id: string,
    label: string,
    phase: HiveTrustedRepairWorkflowDryRunAction["phase"],
    command?: string
  ): HiveTrustedRepairWorkflowDryRunAction => ({
    id,
    label,
    phase,
    status: actionStatus,
    futureTrustedOnly: true,
    ...(command ? { command } : {}),
    blockedReasons: actionBlockedReasons
  });
  return {
    id: item.id,
    title: item.title,
    actor: item.actor,
    status,
    branchName: item.branchName,
    pullRequestTitle: item.pullRequestTitle,
    labels: item.labels,
    allowedFiles: item.allowedFiles,
    artifacts: item.artifacts,
    reproductionCommands: item.reproductionCommands,
    acceptanceCriteria: item.acceptanceCriteria,
    finalValidationCommand: item.finalValidationCommand,
    plannedActions: [
      action("download-visual-hive-artifacts", "Download uploaded Visual Hive artifacts", "artifact_validation"),
      action("validate-repair-policies", "Validate no-network dry-run policy and Visual Hive verdict authority", "artifact_validation"),
      action("checkout-trusted-base", "Checkout trusted base branch in a workflow_run context", "branch_preparation"),
      action("create-repair-branch", `Create repair branch ${item.branchName}`, "branch_preparation", `git switch -c ${item.branchName}`),
      action("run-hive-repair-agent", `Run bounded Hive repair agent for ${item.id}`, "repair_execution"),
      action("run-final-validation", "Run final Visual Hive validation", "validation", item.finalValidationCommand),
      action("open-repair-pull-request", `Open pull request ${item.pullRequestTitle}`, "pull_request")
    ],
    blockedReasons: dedupe(blockedReasons)
  };
}

function trustedRepairWorkflowDryRunBlockedReasons(
  summary: HiveTrustedRepairConsumerSummary,
  items: HiveTrustedRepairWorkflowDryRunItem[]
): string[] {
  const reasons = [...summary.readiness.blockedReasons];
  if (summary.externalCallsMade !== 0) reasons.push("Trusted repair workflow dry-run must be generated from no-network consumer artifacts.");
  if (summary.status !== "ready") reasons.push("Trusted repair consumer summary is not ready.");
  if (!summary.readiness.canStartTrustedRepairWorkflow) reasons.push("Trusted repair consumer summary does not allow workflow start.");
  if (items.length === 0) reasons.push("No trusted repair consumer items are available to plan.");
  if (summary.policy.verdictAuthority !== "visual_hive") reasons.push("Visual Hive must remain the verdict authority.");
  if (summary.policy.consumerExecution !== "dry_run_summary_only") reasons.push("Trusted repair consumer summary must remain dry-run only.");
  if (summary.policy.repairExecution !== "not_executed_by_visual_hive") reasons.push("Visual Hive must not execute repair.");
  if (summary.policy.checkoutCode !== false) reasons.push("Visual Hive must not checkout code during trusted repair consumer summary generation.");
  if (summary.policy.branchCreation !== false) reasons.push("Visual Hive must not create branches during trusted repair workflow dry-run.");
  if (summary.policy.pullRequestCreation !== false) reasons.push("Visual Hive must not open pull requests during trusted repair workflow dry-run.");
  if (summary.policy.issueCreation !== false) reasons.push("Visual Hive must not create issues during trusted repair workflow dry-run.");
  if (summary.policy.hiveNetworkCalls !== false) reasons.push("Trusted repair workflow dry-run must not call Hive.");
  if (summary.policy.providerCalls !== false) reasons.push("Trusted repair workflow dry-run must not call providers.");
  if (summary.policy.visualHiveRerun !== false) reasons.push("Trusted repair workflow dry-run must not rerun Visual Hive.");
  if (!summary.policy.requiresTrustedWorkflow) reasons.push("Trusted repair workflow dry-run requires a trusted workflow.");
  if (summary.consumerActions.wouldCheckoutCode !== false) reasons.push("Trusted repair consumer summary must not checkout code.");
  if (summary.consumerActions.wouldExecuteRepair !== false) reasons.push("Trusted repair consumer summary must not execute repair.");
  if (summary.consumerActions.wouldCallProviders !== false) reasons.push("Trusted repair consumer summary must not call providers.");
  reasons.push(...items.flatMap((item) => item.blockedReasons.map((reason) => `${item.id}: ${reason}`)));
  return dedupe(reasons);
}

function renderHiveTrustedRepairWorkflowDryRunMarkdown(dryRun: HiveTrustedRepairWorkflowDryRun): string {
  return sanitizeText(
    [
      `# Hive Trusted Repair Workflow Dry Run: ${dryRun.project}`,
      "",
      "<!-- visual-hive-hive-trusted-repair-workflow-dry-run -->",
      "",
      "## Summary",
      "",
      `- Status: ${dryRun.status}`,
      `- External calls made: ${dryRun.externalCallsMade}`,
      `- Can run trusted repair workflow: ${dryRun.readiness.canRunTrustedRepairWorkflow}`,
      `- Requested repairs: ${dryRun.summary.requestedRepairs}`,
      `- Ready repairs: ${dryRun.summary.readyRepairs}`,
      `- Blocked repairs: ${dryRun.summary.blockedRepairs}`,
      `- Planned branches: ${dryRun.summary.plannedBranches}`,
      `- Planned pull requests: ${dryRun.summary.plannedPullRequests}`,
      `- Planned future actions: ${dryRun.summary.plannedActions}`,
      `- Blocked future actions: ${dryRun.summary.blockedActions}`,
      "",
      "## Current Dry-run Actions",
      "",
      `- Checked out code: ${dryRun.currentActions.checkedOutCode}`,
      `- Created branches: ${dryRun.currentActions.createdBranches}`,
      `- Opened pull requests: ${dryRun.currentActions.openedPullRequests}`,
      `- Created issues: ${dryRun.currentActions.createdIssues}`,
      `- Called Hive API: ${dryRun.currentActions.calledHiveApi}`,
      `- Called providers: ${dryRun.currentActions.calledProviders}`,
      `- Ran Visual Hive: ${dryRun.currentActions.ranVisualHive}`,
      `- Executed repair: ${dryRun.currentActions.executedRepair}`,
      "",
      "## Policy",
      "",
      "- Visual Hive owns the final deterministic verdict.",
      `- Workflow execution: ${dryRun.policy.workflowExecution}`,
      `- Repair execution: ${dryRun.policy.repairExecution}`,
      `- Checkout code now: ${dryRun.policy.checkoutCode}`,
      `- Branch creation now: ${dryRun.policy.branchCreation}`,
      `- Pull request creation now: ${dryRun.policy.pullRequestCreation}`,
      `- Issue creation now: ${dryRun.policy.issueCreation}`,
      `- Hive network calls now: ${dryRun.policy.hiveNetworkCalls}`,
      `- Provider calls now: ${dryRun.policy.providerCalls}`,
      `- Visual Hive rerun now: ${dryRun.policy.visualHiveRerun}`,
      `- Requires trusted workflow: ${dryRun.policy.requiresTrustedWorkflow}`,
      `- Secrets policy: ${dryRun.policy.secretsPolicy}`,
      "",
      "## Blocked Reasons",
      "",
      ...(dryRun.readiness.blockedReasons.length ? dryRun.readiness.blockedReasons.map((reason) => `- ${reason}`) : ["- None"]),
      "",
      "## Planned Future Workflow Items",
      "",
      ...(dryRun.items.length
        ? dryRun.items.map((item) =>
            [
              `### ${item.id}`,
              "",
              `- Status: ${item.status}`,
              `- Title: ${item.title}`,
              `- Actor: ${item.actor}`,
              `- Branch: \`${item.branchName}\``,
              `- Pull request title: ${item.pullRequestTitle}`,
              `- Final validation: \`${item.finalValidationCommand}\``,
              `- Blocked: ${item.blockedReasons.length ? item.blockedReasons.join("; ") : "no"}`,
              "- Planned actions:",
              ...item.plannedActions.map((action) => `  - ${action.status}: ${action.label}${action.command ? ` (\`${action.command}\`)` : ""}`),
              "- Acceptance criteria:",
              ...item.acceptanceCriteria.map((criterion) => `  - ${criterion}`)
            ].join("\n")
          )
        : ["No trusted repair workflow items are available."])
    ].join("\n")
  ) + "\n";
}

function blockedReasonsFor(context: HiveSourceContext): string[] {
  const reasons = [...context.evidence.hiveReadiness.blockedReasons];
  if (context.mode === "guarded_repair") {
    if (!context.config.enabled) reasons.push("Guarded Hive repair requires integrations.hive.enabled=true in a trusted workflow.");
    if (!context.config.repair.enabled) reasons.push("Guarded Hive repair requires integrations.hive.repair.enabled=true.");
    if (context.config.acmmLevel < 5) reasons.push("Guarded Hive repair requires ACMM level 5 or higher.");
  }
  if (context.mode === "full") {
    reasons.push("Full Hive automation is reserved for a future ACMM L6-compatible workflow and is blocked locally.");
  }
  if (shouldEmitRepairArtifacts(context.mode, context.config)) {
    if (!context.config.repair.prOnly) reasons.push("Hive repair must be PR-only in the current Visual Hive integration.");
    if (!context.config.repair.requireHumanReview) reasons.push("Hive repair requires human review in the current Visual Hive integration.");
    if (!context.config.repair.rerunVisualHive) reasons.push("Hive repair must require a Visual Hive rerun before merge.");
  }
  if (!context.evidence.evidenceContributions.length) reasons.push("Evidence Packet has no evidence contributions.");
  return dedupe(reasons);
}

function shouldEmitMeasuredArtifacts(mode: HiveAutomationMode): boolean {
  return mode !== "advisory";
}

function shouldEmitRepairArtifacts(mode: HiveAutomationMode, config: HiveExportConfig): boolean {
  return config.repair.enabled || mode === "repair_request" || mode === "guarded_repair" || mode === "full";
}

function outputPaths(outputDir: string): HiveExportBundle["outputArtifacts"] {
  return {
    export: `${outputDir}/hive-export.json`,
    beads: `${outputDir}/beads.json`,
    knowledgeFacts: `${outputDir}/knowledge-facts.json`,
    knowledgeGraph: `${outputDir}/knowledge-graph.json`,
    wikiIndex: `${outputDir}/wiki-index.json`,
    issueContext: `${outputDir}/issue-context.md`,
    repairWorkOrders: `${outputDir}/repair-work-orders.json`,
    agentPolicy: `${outputDir}/hive-agent-policy.json`,
    wikiVaultDir: `${outputDir}/wiki`
  };
}

function emptyGraph(): HiveKnowledgeGraph {
  return { schemaVersion: "visual-hive.hive-knowledge-graph.v1", nodes: [], edges: [] };
}

function beadTypeFor(workItem: HandoffWorkItem): HiveBeadType {
  if (workItem.kind === "repair") return "bug";
  if (workItem.kind === "test_creation") return "task";
  if (workItem.kind === "setup") return "chore";
  return "advisory";
}

function beadPriorityFor(priority: HandoffPriority): number {
  if (priority === "critical") return 0;
  if (priority === "high") return 1;
  if (priority === "medium") return 2;
  return 3;
}

function actorFor(workItem: HandoffWorkItem, context: HiveSourceContext): HiveBeadActor {
  if (workItem.kind === "setup") return "ci-maintainer";
  if (workItem.kind === "test_creation" || workItem.kind === "repair") return "quality";
  return context.config.defaultActor;
}

function factTypeFor(workItem: HandoffWorkItem, contribution?: EvidenceContribution): HiveKnowledgeFact["type"] {
  if (contribution?.source === "mutation" || workItem.kind === "test_creation") return "coverage_rule";
  if (workItem.kind === "repair") return "regression";
  if (workItem.kind === "setup") return "integration";
  return "gotcha";
}

function factTitleFor(workItem: HandoffWorkItem, contribution?: EvidenceContribution): string {
  if (contribution?.source === "mutation") return `Mutation adequacy gap: ${contribution.operator ?? workItem.id}`;
  return workItem.title;
}

function confidenceFor(contribution?: EvidenceContribution): number {
  if (!contribution) return 0.75;
  if (contribution.gating && contribution.status === "failed") return 0.95;
  if (contribution.status === "blocked") return 0.9;
  if (contribution.authority === "advisory") return 0.72;
  return 0.82;
}

function factTagsFor(workItem: HandoffWorkItem, contribution: EvidenceContribution | undefined, context: HiveSourceContext): string[] {
  return dedupe([
    "visual-hive",
    "hive",
    workItem.kind,
    contribution?.source,
    contribution?.kind,
    contribution?.contractId ? `contract:${contribution.contractId}` : undefined,
    contribution?.targetId ? `target:${contribution.targetId}` : undefined,
    contribution?.operator ? `mutation:${contribution.operator}` : undefined,
    `verdict:${context.evidence.verdictSummary.visualHiveVerdict}`
  ].filter((value): value is string => Boolean(value)));
}

function renderFactBody(workItem: HandoffWorkItem, contributions: EvidenceContribution[], context: HiveSourceContext): string {
  return sanitizeText(
    [
      workItem.summary,
      "",
      "Evidence:",
      ...(contributions.length ? contributions.map((contribution) => `- ${contribution.key}: ${contribution.reason}`) : workItem.evidenceKeys.map((key) => `- ${key}`)),
      "",
      "Suggested next steps:",
      ...workItem.suggestedNextSteps.map((step) => `- ${step}`),
      "",
      `Visual Hive verdict: ${context.evidence.verdictSummary.visualHiveVerdict}`
    ].join("\n")
  );
}

function renderBeadNotes(workItem: HandoffWorkItem): string {
  return sanitizeText(
    [
      workItem.summary,
      "",
      "Evidence keys:",
      ...workItem.evidenceKeys.map((key) => `- ${key}`),
      "",
      "Artifacts:",
      ...(workItem.artifacts.length ? workItem.artifacts.map((artifact) => `- ${artifact}`) : ["- .visual-hive/evidence-packet.json"]),
      "",
      "Suggested next steps:",
      ...workItem.suggestedNextSteps.map((step) => `- ${step}`)
    ].join("\n")
  );
}

function renderUxScoutBeadNotes(context: NonNullable<HandoffPacket["uxScoutContext"]>): string {
  return sanitizeText(
    [
      "UX Scout review request from Visual Hive.",
      "",
      "Review only the affected flows below. This is Tier A code/text review; do not infer rendered evidence.",
      "",
      "Affected flows:",
      ...context.affectedFlows.map((flow) =>
        `- ${flow.id}: routes=${flow.routes.join(", ") || "n/a"}; selectors=${flow.selectors.join(", ") || "n/a"}; changed files=${flow.changedFiles.join(", ") || "n/a"}`
      ),
      "",
      "Context artifact:",
      "- .visual-hive/ux-scout-context.json",
      "",
      "Guardrails:",
      ...context.guardrails.map((guardrail) => `- ${guardrail}`)
    ].join("\n")
  );
}

function repairObjectiveFor(workItem: HandoffWorkItem): string {
  if (workItem.kind === "test_creation") return `Add or strengthen deterministic tests so Visual Hive catches: ${workItem.title}`;
  if (workItem.kind === "setup") return `Unblock Visual Hive evidence collection for: ${workItem.title}`;
  return `Repair the deterministic Visual Hive failure: ${workItem.title}`;
}

function allowedRepairActionsFor(workItem: HandoffWorkItem): string[] {
  const base = ["read_sanitized_evidence", "inspect_repo_files", "create_branch", "open_pull_request", "request_visual_hive_rerun"];
  if (workItem.kind === "test_creation") return [...base, "edit_tests", "edit_visual_hive_config"];
  if (workItem.kind === "setup") return [...base, "edit_workflow_or_setup_files"];
  return [...base, "edit_source", "edit_tests"];
}

function forbiddenRepairActions(): string[] {
  return [
    "decide_visual_hive_verdict",
    "read_secret_values",
    "print_secret_values",
    "approve_baselines_without_human_review",
    "run_protected_targets_from_untrusted_pr",
    "push_directly_to_main",
    "auto_merge_without_visual_hive_pass"
  ];
}

function likelyFilesFor(context: HiveSourceContext, contributions: EvidenceContribution[]): string[] {
  const changed = context.evidence.plan?.effectiveChangedFiles ?? context.evidence.plan?.changedFiles ?? [];
  const repoHints = context.evidence.repoIntelligence?.riskSignals.flatMap((signal) => signal.evidence).filter(Boolean) ?? [];
  const contractTargets = contributions.flatMap((contribution) => [contribution.contractId, contribution.targetId].filter(Boolean) as string[]);
  return dedupe([...changed, ...repoHints, ...contractTargets.map((value) => `visual-hive.config.yaml#${value}`)]).slice(0, 12);
}

function suggestedFiles(context: HiveSourceContext, workSources: HiveWorkSource[]): string[] {
  return dedupe([
    ...(context.evidence.plan?.effectiveChangedFiles ?? context.evidence.plan?.changedFiles ?? []),
    ...workSources.flatMap((source) => source.contributions.flatMap((contribution) => [contribution.contractId, contribution.targetId].filter(Boolean) as string[]).map((id) => `visual-hive.config.yaml#${id}`)),
    ".visual-hive/evidence-packet.json",
    ".visual-hive/report.json",
    ".visual-hive/mutation-report.json"
  ]).slice(0, 16);
}

function titleForContribution(contribution: EvidenceContribution): string {
  if (contribution.operator) return `Strengthen tests for ${contribution.operator}`;
  if (contribution.contractId) return `Repair ${contribution.contractId}`;
  return `Review ${contribution.source}.${contribution.kind}`;
}

function suggestedStepsForContribution(contribution: EvidenceContribution): string[] {
  if (contribution.source === "mutation") return ["Add a deterministic assertion that kills this mutation.", "Rerun visual-hive mutate.", "Regenerate the Evidence Packet."];
  if (contribution.status === "blocked") return ["Resolve the blocked setup or target lifecycle issue.", "Rerun visual-hive pipeline.", "Regenerate the Hive export."];
  return ["Inspect linked artifacts.", "Repair the UI or reviewed baseline.", "Rerun Visual Hive and verify the verdict passes."];
}

function listEvidence(contributions: EvidenceContribution[]): string[] {
  if (!contributions.length) return ["- None"];
  return contributions.map((contribution) => `- [${contribution.status}] ${contribution.key}: ${contribution.reason}`);
}

function dedupeFacts(facts: HiveKnowledgeFact[]): HiveKnowledgeFact[] {
  const seen = new Set<string>();
  const result: HiveKnowledgeFact[] = [];
  for (const fact of facts) {
    if (seen.has(fact.slug)) continue;
    seen.add(fact.slug);
    result.push(fact);
  }
  return result;
}

function dedupeEdges(edges: HiveGraphEdge[]): HiveGraphEdge[] {
  const seen = new Set<string>();
  const result: HiveGraphEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}|${edge.predicate}|${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

function compactRecord(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => sanitizeText(value)).filter(Boolean))];
}

function dedupeModes(values: HiveAutomationMode[]): HiveAutomationMode[] {
  return [...new Set(values)];
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function safeSlug(value: string): string {
  return sanitizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function yamlString(value: string): string {
  return JSON.stringify(sanitizeText(value));
}

function normalizePath(value: string): string {
  return sanitizeText(value.replaceAll("\\", "/"));
}

function resolveArtifact(rootDir: string, artifactPath: string): string {
  return path.isAbsolute(artifactPath) ? artifactPath : path.resolve(rootDir, artifactPath);
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeValue(child)]));
  return value;
}
