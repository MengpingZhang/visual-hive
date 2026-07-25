import path from "node:path";
import { sanitizeArtifactPathForIssue, sanitizeArtifactPathsForMarkdown, sanitizeText } from "../utils/sanitize.js";
import { readJson, writeJson, writeText } from "../utils/files.js";
import type { EvidenceContribution, EvidencePacket } from "../evidence/types.js";
import type { BuildHandoffOptions, HandoffArtifacts, HandoffMode, HandoffPacket, HandoffPriority, HandoffWorkItem, HiveBeadDryRunRequest, HiveHandoffResult } from "./types.js";
import { contributionKey } from "./types.js";
import type { UxScoutContext } from "../ux/types.js";

const DEFAULT_LABELS = ["visual-hive", "hive/quality", "ai-ready"];
const DEFAULT_AGENT = "quality";
const HUMAN_APPROVAL = [
  "github_issue_creation",
  "hive_bead_creation",
  "provider_upload_enablement",
  "baseline_approval",
  "protected_target_run"
];

export async function readEvidencePacket(filePath: string): Promise<EvidencePacket> {
  const packet = await readJson<EvidencePacket>(filePath);
  if (!["visual-hive.evidence-packet.v1", "visual-hive.evidence-packet.v2"].includes(String(packet.schemaVersion))) {
    throw new Error(`Unsupported Evidence Packet schema at ${filePath}: ${String(packet.schemaVersion)}`);
  }
  return sanitizeValue(packet) as EvidencePacket;
}

export function buildHandoffArtifacts(options: BuildHandoffOptions): HandoffArtifacts {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const mode = options.mode ?? "dry_run";
  const labels = dedupe([...(options.labels?.length ? options.labels : options.evidencePacket.hiveReadiness.suggestedLabels), ...DEFAULT_LABELS]);
  const handoffPacketPath = normalizeArtifactPath(options.handoffPacketPath ?? ".visual-hive/handoff.json");
  const issueBodyPath = normalizeArtifactPath(options.issueBodyPath ?? ".visual-hive/hive-issue.md");
  const beadRequestPath = normalizeArtifactPath(options.beadRequestPath ?? ".visual-hive/hive-bead-request.json");
  const resultPath = normalizeArtifactPath(options.resultPath ?? ".visual-hive/hive-handoff-result.json");
  const evidencePacketPath = normalizeArtifactPath(options.evidencePacketPath);
  const beadTarget = beadTargetFor(options, mode);
  const blockedReasons = blockedReasonsFor(options.evidencePacket, mode, beadTarget);
  const workItems = buildWorkItems(options.evidencePacket);
  const uxScoutContext = options.uxScoutContext ?? emptyUxScoutContext(options.evidencePacket);
  const status = blockedReasons.length ? "blocked" : "ready";
  const issueTitle = issueTitleFor(options.evidencePacket);
  const handoff: HandoffPacket = sanitizeValue({
    schemaVersion: "visual-hive.handoff.v1",
    generatedAt,
    project: options.evidencePacket.project,
    mode,
    status,
    externalCallsMade: 0,
    sourceEvidencePacket: evidencePacketPath,
    labels,
    verdict: options.evidencePacket.verdictSummary,
    governance: {
      verdictAuthority: "visual_hive",
      handoffAuthority: "advisory_repair_routing",
      networkPolicy: "no_network_calls_in_dry_run",
      secretPolicy: "redacted_values_names_only",
      requiresHumanApprovalFor: HUMAN_APPROVAL
    },
    workItems,
    uxScoutContext,
    githubIssue: {
      title: issueTitle,
      labels,
      bodyPath: issueBodyPath,
      dedupeSignature: dedupeSignature(options.evidencePacket),
      trustedWorkflowRequired: true
    },
    hiveBeadRequest: {
      dryRun: true,
      requestPath: beadRequestPath,
      agent: options.agent ?? options.hiveIntegration?.beadApi?.agent ?? DEFAULT_AGENT,
      labels,
      evidencePacketPath,
      handoffPacketPath,
      ...beadTarget
    },
    blockedReasons
  }) as HandoffPacket;

  const issueBody = renderHiveIssueBody(handoff, options.evidencePacket, options.rootDir);
  const beadRequest: HiveBeadDryRunRequest = sanitizeValue({
    schemaVersion: "visual-hive.hive-bead-request.v1",
    dryRun: true,
    externalCallsMade: 0,
    project: handoff.project,
    agent: handoff.hiveBeadRequest.agent,
    labels: handoff.labels,
    objective: objectiveFor(options.evidencePacket),
    evidencePacketPath,
    handoffPacketPath,
    issueBodyPath,
    target: beadTarget,
    verdict: handoff.verdict,
    workItems: handoff.workItems,
    allowedActions: [
      "read_sanitized_evidence",
      "inspect_artifact_paths",
      "draft_repair_plan",
      "suggest_tests",
      "open_pull_request_after_human_approval"
    ],
    forbiddenActions: [
      "decide_visual_hive_verdict",
      "read_secret_values",
      "approve_baselines_without_human_review",
      "run_protected_targets_without_approval",
      "upload_to_paid_providers_without_policy_authorization"
    ]
  }) as HiveBeadDryRunRequest;
  const result: HiveHandoffResult = sanitizeValue({
    schemaVersion: "visual-hive.hive-handoff-result.v1",
    generatedAt,
    project: handoff.project,
    mode,
    status: blockedReasons.length ? "blocked" : "dry_run_written",
    externalCallsMade: 0,
    artifacts: {
      handoff: handoffPacketPath,
      issue: issueBodyPath,
      beadRequest: beadRequestPath,
      result: resultPath,
      evidencePacket: evidencePacketPath
    },
    blockedReasons,
    message: blockedReasons.length
      ? "Hive handoff dry-run artifacts were written, but handoff is blocked until evidence is sufficient."
      : "Hive handoff dry-run artifacts were written with zero external calls."
  }) as HiveHandoffResult;

  return { handoff, issueBody, beadRequest, result };
}

export async function writeHandoffArtifacts(
  options: BuildHandoffOptions & { rootDir: string }
): Promise<HandoffArtifacts & { handoffPath: string; issuePath: string; beadRequestPath: string; resultPath: string }> {
  const artifacts = buildHandoffArtifacts(options);
  const handoffPath = resolve(options.rootDir, options.handoffPacketPath ?? ".visual-hive/handoff.json");
  const issuePath = resolve(options.rootDir, options.issueBodyPath ?? ".visual-hive/hive-issue.md");
  const beadRequestPath = resolve(options.rootDir, options.beadRequestPath ?? ".visual-hive/hive-bead-request.json");
  const resultPath = resolve(options.rootDir, options.resultPath ?? ".visual-hive/hive-handoff-result.json");
  await writeJson(handoffPath, artifacts.handoff);
  await writeText(issuePath, artifacts.issueBody);
  await writeJson(beadRequestPath, artifacts.beadRequest);
  await writeJson(resultPath, artifacts.result);
  return { ...artifacts, handoffPath, issuePath, beadRequestPath, resultPath };
}

export function renderHiveIssueBody(handoff: HandoffPacket, evidence: EvidencePacket, rootDir = process.cwd()): string {
  const gating = evidence.evidenceContributions.filter((contribution) => contribution.gating);
  const advisory = evidence.evidenceContributions.filter((contribution) => !contribution.gating);
  const reproduction = evidence.deterministicReport?.reproductionCommands ?? [];
  const evidenceResources = handoffEvidenceResources(handoff, evidence, rootDir);
  const visualRefs = visualMapReferences(handoff, evidence);
  const validationCommands = handoffValidationCommands(evidence);
  const failedContracts = failedContractLines(evidence);
  const affectedSurfaces = affectedSurfaceLines(evidence);
  const screenshotEvidence = screenshotEvidenceLines(evidence, rootDir);
  const mutationEvidence = mutationEvidenceLines(evidence);
  const lines = [
    `# ${handoff.githubIssue.title}`,
    "",
    "<!-- visual-hive-hive-handoff -->",
    "",
    "## Summary",
    "",
    `- Project: ${handoff.project}`,
    `- Visual Hive verdict: ${handoff.verdict.visualHiveVerdict}`,
    `- Handoff status: ${handoff.status}`,
    `- External calls made: ${handoff.externalCallsMade}`,
    `- Evidence packet: ${handoff.sourceEvidencePacket}`,
    `- Dedupe fingerprint: ${handoff.githubIssue.dedupeSignature}`,
    `- Labels: ${handoff.labels.join(", ")}`,
    "",
    "## UX Scout Context",
    "",
    `- Trigger: ${handoff.uxScoutContext.trigger}`,
    `- Visual Hive verdict: ${handoff.uxScoutContext.visualHiveVerdict}`,
    `- Changed files: ${handoff.uxScoutContext.changedFiles.join(", ") || "none recorded"}`,
    `- Affected flows: ${handoff.uxScoutContext.affectedFlows.map((flow) => flow.id).join(", ") || "none"}`,
    "",
    "UX Scout must review only the affected flows in this section. Visual Hive remains the deterministic verdict authority.",
    ...handoff.uxScoutContext.affectedFlows.flatMap((flow) => [
      "",
      `### ${flow.id}`,
      `- Route(s): ${flow.routes.join(", ") || "not recorded"}`,
      `- Selector(s): ${flow.selectors.join(", ") || "not recorded"}`,
      `- Status: ${flow.status}`,
      `- Failed steps: ${flow.failedSteps.join("; ") || "none"}`,
      `- Evidence: ${flow.evidence.join(", ")}`
    ]),
    "",
    "## Failing Contracts",
    "",
    ...(failedContracts.length ? failedContracts : ["- No failing deterministic contracts in the latest Evidence Packet."]),
    "",
    "## Affected Surface",
    "",
    ...(affectedSurfaces.length ? affectedSurfaces : ["- See `.visual-hive/report.json` selector assertions and `.visual-hive/repo-map.json` visual-map nodes."]),
    "",
    "## Gating Evidence",
    "",
    ...listContributions(gating),
    "",
    "## Advisory Evidence",
    "",
    ...listContributions(advisory.slice(0, 12)),
    "",
    "## Work Items",
    "",
    ...(handoff.workItems.length
      ? handoff.workItems.map((item) => `- [${item.priority}] ${item.kind}: ${item.title} (${item.evidenceKeys.join(", ") || "no evidence key"})`)
      : ["- No work items generated."]),
    "",
    "## Screenshot And Diff Evidence",
    "",
    ...(screenshotEvidence.length ? screenshotEvidence : ["- No screenshot or diff evidence in the latest Evidence Packet."]),
    "",
    "## Mutation Evidence",
    "",
    ...(mutationEvidence.length ? mutationEvidence : ["- No mutation report evidence in the latest Evidence Packet."]),
    "",
    "## Reproduction Commands",
    "",
    ...(reproduction.length ? reproduction.map((command) => `- \`${command}\``) : ["- See Evidence Packet artifacts."]),
    "",
    "## Evidence Resources",
    "",
    ...evidenceResources.map((resource) => `- ${resource.label}: ${resource.path}`),
    "",
    "## Visual Map References",
    "",
    ...(visualRefs.length ? visualRefs.map((reference) => `- ${reference}`) : ["- Run `visual-hive analyze` to generate `.visual-hive/repo-map.json` visual-map nodes."]),
    "",
    "## Validation Commands",
    "",
    ...validationCommands.map((command) => `- \`${command}\``),
    "- After Hive repairs code/tests, rerun `visual-hive pipeline --mode pr --ci` or the repository's trusted Visual Hive workflow before closing.",
    "",
    "## Governance And Guardrails",
    "",
    "- Visual Hive's deterministic Verdict Engine owns pass/fail.",
    "- Hive, LLMs, MCP tools, and agents may repair or route work, but they do not decide the verdict.",
    "- This dry-run handoff made zero network calls and did not create a GitHub issue or Hive Bead.",
    "- Trusted workflows must consume uploaded sanitized artifacts and must not execute untrusted PR code.",
    "- Do not blindly approve baselines to make the issue disappear.",
    "- Do not weaken screenshot thresholds, selector assertions, mutation thresholds, or console/network policies without explicit review.",
    "- Do not treat LLM/Hive judgment as the Visual Hive verdict.",
    "- Rerun Visual Hive after every repair and use the new deterministic verdict as the close signal."
  ];
  if (handoff.blockedReasons.length) lines.splice(15, 0, `- Blocked reasons: ${handoff.blockedReasons.join("; ")}`);
  return `${sanitizeArtifactPathsForMarkdown(rootDir, lines.join("\n"))}\n`;
}

function emptyUxScoutContext(evidence: EvidencePacket): UxScoutContext {
  return {
    schemaVersion: "visual-hive.ux-scout-context.v1",
    generatedAt: new Date().toISOString(),
    project: evidence.project,
    trigger: "affected-flow",
    visualHiveVerdict: evidence.verdictSummary.visualHiveVerdict,
    changedFiles: evidence.plan?.effectiveChangedFiles ?? evidence.plan?.changedFiles ?? [],
    affectedFlows: [],
    sourceArtifacts: [".visual-hive/flows.json", ".visual-hive/evidence-packet.json", ".visual-hive/handoff.json"],
    guardrails: [
      "UX Scout reviews only affectedFlows in this context.",
      "Visual Hive remains the deterministic verdict authority.",
      "UX Scout is advisory-only and must not modify baselines, thresholds, or source code."
    ]
  };
}

function failedContractLines(evidence: EvidencePacket): string[] {
  const deterministic = evidence.deterministicReport?.failedContracts ?? [];
  const fromContributions = evidence.evidenceContributions.filter((item) => item.contractId && item.status === "failed");
  return dedupe([
    ...deterministic.map((contract) => {
      const errors = contract.errors.length ? `; errors=${contract.errors.slice(0, 2).join(" | ")}` : "";
      return `- ${contract.contractId} on ${contract.targetId}${errors}`;
    }),
    ...fromContributions.map((contribution) => `- ${contribution.contractId} on ${contribution.targetId ?? "unknown-target"}: ${contribution.reason}`)
  ]).slice(0, 12);
}

function affectedSurfaceLines(evidence: EvidencePacket): string[] {
  const screenshotSurfaces = (evidence.deterministicReport?.screenshotEvidence ?? []).map((shot) =>
    [
      `contract=${shot.contractId}`,
      `route=${shot.route}`,
      `viewport=${shot.viewport}`,
      "selectors=see .visual-hive/report.json selectorAssertions",
      "components=see .visual-hive/repo-map.json visual map"
    ].join("; ")
  );
  const mutationSurfaces = [
    ...(evidence.mutation?.killedOperators ?? []),
    ...(evidence.mutation?.survivedOperators ?? [])
  ].flatMap((result) =>
    (result.affected ?? []).map((surface) =>
      [
        `mutation=${result.operator}`,
        `contract=${surface.contractId}`,
        surface.targetId ? `target=${surface.targetId}` : undefined,
        surface.route ? `route=${surface.route}` : undefined,
        surface.component ? `component=${surface.component}` : undefined,
        surface.viewport ? `viewport=${surface.viewport}` : undefined
      ]
        .filter(Boolean)
        .join("; ")
    )
  );
  const targetRefs = [
    ...(evidence.plan?.selectedTargets ?? []).map((target) => `target=${target}; source=plan`),
    ...(evidence.plan?.selectedContracts ?? []).map((contract) => `contract=${contract}; source=plan`)
  ];
  return dedupe([...screenshotSurfaces, ...mutationSurfaces, ...targetRefs]).map((line) => `- ${line}`).slice(0, 16);
}

function screenshotEvidenceLines(evidence: EvidencePacket, rootDir: string): string[] {
  return (evidence.deterministicReport?.screenshotEvidence ?? [])
    .map((shot) =>
      [
        `- ${shot.contractId}/${shot.screenshotName} ${shot.status}`,
        `route=${shot.route}`,
        `viewport=${shot.viewport}`,
        `baseline=${sanitizeArtifactPathForIssue(rootDir, shot.baselinePath)}`,
        `actual=${sanitizeArtifactPathForIssue(rootDir, shot.actualPath)}`,
        shot.diffPath ? `diff=${sanitizeArtifactPathForIssue(rootDir, shot.diffPath)}` : undefined,
        typeof shot.actualDiffPixelRatio === "number" ? `diffRatio=${shot.actualDiffPixelRatio}` : undefined,
        typeof shot.actualDiffPixels === "number" ? `diffPixels=${shot.actualDiffPixels}` : undefined
      ]
        .filter(Boolean)
        .join("; ")
    )
    .slice(0, 12);
}

function mutationEvidenceLines(evidence: EvidencePacket): string[] {
  const killed = (evidence.mutation?.killedOperators ?? []).map((result) =>
    `- killed ${result.operator}; contracts=${result.contractIds.join(", ") || "none"}; next=${result.suggestedMissingTest ?? "Current contracts killed this mutation."}`
  );
  const survived = (evidence.mutation?.survivedOperators ?? []).map((result) =>
    `- survived ${result.operator}; contracts=${result.contractIds.join(", ") || "none"}; validation=${result.validationCommand ?? "visual-hive mutate"}; next=${result.suggestedMissingTest ?? "Add a contract that kills this mutation."}`
  );
  const notApplicable = (evidence.mutation?.notApplicableOperators ?? []).map((operator) => `- not_applicable ${operator}; no relevant selected contract`);
  const score = evidence.mutation ? [`- score=${evidence.mutation.score}; killed=${evidence.mutation.killed}; total=${evidence.mutation.total}; minScore=${evidence.mutation.minScore}`] : [];
  return [...score, ...survived, ...killed, ...notApplicable].slice(0, 18);
}

function handoffEvidenceResources(handoff: HandoffPacket, evidence: EvidencePacket, rootDir: string): Array<{ label: string; path: string }> {
  const resources: Array<{ label: string; path?: string }> = [
    { label: "Evidence packet", path: handoff.hiveBeadRequest.evidencePacketPath },
    { label: "Handoff packet", path: handoff.hiveBeadRequest.handoffPacketPath },
    { label: "Hive issue body", path: handoff.githubIssue.bodyPath },
    { label: "Hive bead dry-run request", path: handoff.hiveBeadRequest.requestPath },
    { label: "Hive handoff result", path: ".visual-hive/hive-handoff-result.json" },
    { label: "Handoff validation", path: ".visual-hive/hive-handoff-validation.json" },
    { label: "Test Creation Plan", path: ".visual-hive/test-creation-plan.json" },
    { label: "Test Creation Plan markdown", path: ".visual-hive/test-creation-plan.md" },
    { label: "Hive native export", path: ".visual-hive/hive/hive-export.json" },
    { label: "Hive Beads", path: ".visual-hive/hive/beads.json" },
    { label: "Hive knowledge facts", path: ".visual-hive/hive/knowledge-facts.json" },
    { label: "Hive knowledge graph", path: ".visual-hive/hive/knowledge-graph.json" },
    { label: "Hive wiki index", path: ".visual-hive/hive/wiki-index.json" },
    { label: "Hive issue context", path: ".visual-hive/hive/issue-context.md" },
    { label: "Hive repair work orders", path: ".visual-hive/hive/repair-work-orders.json" },
    { label: "Hive agent policy", path: ".visual-hive/hive/hive-agent-policy.json" },
    { label: "Guarded repair preview", path: ".visual-hive/hive/guarded-repair-preview.json" },
    { label: "Repair request envelope", path: ".visual-hive/hive/repair-request-envelope.json" },
    { label: "Trusted repair consumer summary", path: ".visual-hive/hive/trusted-repair-consumer-summary.json" },
    { label: "Trusted repair workflow dry-run", path: ".visual-hive/hive/trusted-repair-workflow-dry-run.json" },
    { label: "Repo map", path: evidence.sourceArtifacts.repoMap },
    { label: "Deterministic report", path: evidence.sourceArtifacts.report },
    { label: "Mutation report", path: evidence.sourceArtifacts.mutationReport },
    { label: "Triage report", path: evidence.sourceArtifacts.triageReport },
    { label: "Generated spec", path: evidence.deterministicReport?.generatedSpecPath }
  ];
  return dedupeResources(resources)
    .filter((resource): resource is { label: string; path: string } => Boolean(resource.path))
    .map((resource) => ({ ...resource, path: sanitizeArtifactPathForIssue(rootDir, resource.path) }))
    .slice(0, 28);
}

function visualMapReferences(handoff: HandoffPacket, evidence: EvidencePacket): string[] {
  const values = [
    ...handoff.workItems.flatMap((item) => item.evidenceKeys.map((key) => `evidence:${key}`)),
    ...evidence.evidenceContributions.flatMap((contribution) => [
      contribution.contractId ? `contract:${contribution.contractId}` : undefined,
      contribution.targetId ? `target:${contribution.targetId}` : undefined,
      contribution.operator ? `mutation:${contribution.operator}` : undefined
    ]),
    ...(evidence.plan?.selectedTargets ?? []).map((targetId) => `target:${targetId}`),
    ...(evidence.plan?.selectedContracts ?? []).map((contractId) => `contract:${contractId}`),
    ...(evidence.deterministicReport?.screenshotEvidence ?? []).flatMap((shot) => [
      `screenshot:${shot.contractId}:${shot.screenshotName}:${shot.viewport}`,
      `route:${shot.route}`,
      `viewport:${shot.viewport}`
    ]),
    ...(evidence.mutation?.killedOperators ?? []).map((result) => `mutation:${result.operator}`),
    ...(evidence.mutation?.survivedOperators ?? []).map((result) => `mutation:${result.operator}`),
    ...(evidence.triage?.findings ?? []).flatMap((finding) => [
      ...((finding.contractIds ?? []).map((contractId) => `contract:${contractId}`)),
      ...((finding.targetIds ?? []).map((targetId) => `target:${targetId}`))
    ])
  ];
  return dedupe(values.filter((value): value is string => Boolean(value))).slice(0, 24);
}

function handoffValidationCommands(evidence: EvidencePacket): string[] {
  return dedupe([
    ...(evidence.deterministicReport?.reproductionCommands ?? []),
    "visual-hive evidence",
    "visual-hive handoff --dry-run",
    "visual-hive hive export --dry-run --mode repair_request",
    "visual-hive hive guarded-repair-preview",
    "visual-hive hive repair-request-envelope",
    "visual-hive hive trusted-repair-consumer-summary",
    "visual-hive hive trusted-repair-workflow-dry-run",
    "visual-hive handoff-validate",
    "visual-hive test-creation-plan"
  ]).slice(0, 16);
}

function dedupeResources(resources: Array<{ label: string; path?: string }>): Array<{ label: string; path?: string }> {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = `${resource.label}:${resource.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildWorkItems(evidence: EvidencePacket): HandoffWorkItem[] {
  const failed = evidence.evidenceContributions.filter((contribution) => contribution.gating && contribution.status === "failed");
  const blocked = evidence.evidenceContributions.filter((contribution) => contribution.gating && contribution.status === "blocked");
  const mutationSurvivors = evidence.evidenceContributions.filter((contribution) => contribution.source === "mutation" && contribution.kind === "mutation_survivor");
  const repoCoverageGaps = evidence.repoIntelligence?.coverageGaps ?? [];
  const layerGaps = evidence.testingLayers
    .filter((layer) => layer.status === "missing" || layer.status === "unknown" || layer.status === "partial")
    .sort((left, right) => layerPriorityScore(right) - layerPriorityScore(left) || left.id - right.id);
  const workItems: HandoffWorkItem[] = [];

  for (const contribution of [...failed, ...blocked].slice(0, 8)) {
    workItems.push(workItemForContribution(contribution, evidence));
  }
  for (const contribution of mutationSurvivors.filter((item) => !failed.includes(item)).slice(0, 4)) {
    workItems.push(workItemForContribution(contribution, evidence));
  }
  for (const gap of repoCoverageGaps.filter((gap) => gap.severity === "high" || gap.severity === "medium").slice(0, 6)) {
    workItems.push(workItemForRepoCoverageGap(gap));
  }
  for (const layer of layerGaps.slice(0, 6)) {
    workItems.push(workItemForTestingLayer(layer));
  }
  if (!workItems.length && evidence.verdictSummary.visualHiveVerdict === "passed") {
    workItems.push({
      id: "review-evidence",
      kind: "review",
      priority: "low",
      title: "Review passing Visual Hive evidence for baseline and coverage health",
      summary: "The latest Evidence Packet is passing; review advisory signals before expanding automation.",
      evidenceKeys: evidence.verdictSummary.advisoryOnly.slice(0, 8),
      artifacts: [".visual-hive/evidence-packet.json", ".visual-hive/evidence-summary.md"],
      suggestedNextSteps: ["Review advisory-only evidence.", "Add missing contracts or mutation mappings before enabling stricter lanes."]
    });
  }
  return dedupeWorkItems(workItems);
}

function workItemForRepoCoverageGap(gap: NonNullable<EvidencePacket["repoIntelligence"]>["coverageGaps"][number]): HandoffWorkItem {
  const kind = [2, 3, 4, 5, 6, 9].includes(gap.layer) ? "test_creation" : [0, 1, 7, 8].includes(gap.layer) ? "setup" : "review";
  const priority: HandoffPriority = gap.severity === "high" ? "high" : gap.severity === "medium" ? "medium" : "low";
  return {
    id: safeId(`repo-coverage-gap-${gap.id}`),
    kind,
    priority,
    title: `Close repo intelligence gap: ${gap.id}`,
    summary: gap.message,
    evidenceKeys: [`repo_coverage_gap.${gap.id}`],
    artifacts: [".visual-hive/repo-map.json", ".visual-hive/repo-context.md", gap.suggestedArtifact],
    suggestedNextSteps: [
      `Review ${gap.suggestedArtifact}.`,
      "Add or normalize deterministic evidence for the affected testing layer.",
      "Rerun `visual-hive analyze` and regenerate the Evidence Packet after changes."
    ]
  };
}

function workItemForTestingLayer(layer: EvidencePacket["testingLayers"][number]): HandoffWorkItem {
  const kind = workItemKindForLayer(layer.id);
  const priority = layer.status === "missing" ? "high" : layer.status === "unknown" ? "medium" : "low";
  const gapSummary = layer.gaps.length ? layer.gaps.join("; ") : `Layer ${layer.id} (${layer.name}) is ${layer.status}.`;
  return {
    id: safeId(`testing-layer-${layer.id}-${layer.status}`),
    kind,
    priority,
    title: `${actionVerbFor(kind)} ${layer.name} evidence`,
    summary: gapSummary,
    evidenceKeys: [`testing_layer.${layer.id}.${layer.status}`],
    artifacts: layer.evidence.length ? layer.evidence : [".visual-hive/evidence-packet.json", ".visual-hive/testing-layers.json"],
    suggestedNextSteps: suggestedStepsForLayer(layer)
  };
}

function layerPriorityScore(layer: EvidencePacket["testingLayers"][number]): number {
  const statusScore = layer.status === "missing" ? 30 : layer.status === "unknown" ? 20 : layer.status === "partial" ? 10 : 0;
  const layerScore = layer.id === 9 ? 5 : [1, 2, 3, 4, 6].includes(layer.id) ? 3 : 0;
  return statusScore + layerScore;
}

function workItemKindForLayer(layerId: number): HandoffWorkItem["kind"] {
  if ([2, 3, 4, 5, 6, 9].includes(layerId)) return "test_creation";
  if ([0, 1, 7, 8].includes(layerId)) return "setup";
  return "review";
}

function actionVerbFor(kind: HandoffWorkItem["kind"]): string {
  if (kind === "test_creation") return "Add";
  if (kind === "setup") return "Complete";
  return "Review";
}

function suggestedStepsForLayer(layer: EvidencePacket["testingLayers"][number]): string[] {
  const common = ["Review `.visual-hive/testing-layers.json`.", "Keep agent output advisory and rerun Visual Hive after changes."];
  if (layer.id === 1) return ["Run workflow/security/readiness audits.", "Add safe PR workflow evidence if missing.", ...common];
  if (layer.id === 2) return ["Expose unit test scripts or evidence in repo intelligence.", "Add unit tests for logic not covered by visual contracts.", ...common];
  if (layer.id === 3) return ["Add accessibility or component evidence for critical UI states.", "Prefer deterministic checks before LLM review.", ...common];
  if (layer.id === 4) return ["Add API or route contract evidence for data-driven UI states.", "Connect API failures to visible contracts.", ...common];
  if (layer.id === 8) return ["Model protected or canary targets only in trusted lanes.", "Report missing secret names only, never values.", ...common];
  if (layer.id === 9) return ["Run `visual-hive mutate`.", "Use survived mutations as concrete missing-test tasks.", ...common];
  if (layer.id === 10) return ["Record history, flake, cost, and baseline evidence.", "Use trends to decide which lanes need stabilization.", ...common];
  if (layer.id === 11) return ["Generate handoff and agent packets from sanitized evidence.", "Do not let agents decide the verdict.", ...common];
  return common;
}

function workItemForContribution(contribution: EvidenceContribution, evidence: EvidencePacket): HandoffWorkItem {
  const key = contributionKey(contribution);
  const kind = contribution.source === "mutation" ? "test_creation" : contribution.status === "blocked" ? "setup" : "repair";
  return {
    id: safeId(key),
    kind,
    priority: priorityFor(contribution, evidence),
    title: titleFor(contribution),
    summary: contribution.reason,
    evidenceKeys: [key],
    artifacts: contribution.artifacts.length ? contribution.artifacts : [".visual-hive/evidence-packet.json"],
    suggestedNextSteps: suggestedStepsFor(contribution)
  };
}

function priorityFor(contribution: EvidenceContribution, evidence: EvidencePacket): HandoffPriority {
  if (evidence.verdictSummary.visualHiveVerdict === "failed" && contribution.gating) return "high";
  if (contribution.status === "blocked") return "critical";
  if (contribution.source === "mutation") return "high";
  if (contribution.status === "warning") return "medium";
  return "low";
}

function titleFor(contribution: EvidenceContribution): string {
  if (contribution.source === "mutation" && contribution.operator) return `Strengthen tests for survived mutation ${contribution.operator}`;
  if (contribution.contractId) return `Repair ${contribution.contractId}: ${contribution.kind}`;
  return `Review ${contribution.source}.${contribution.kind}`;
}

function suggestedStepsFor(contribution: EvidenceContribution): string[] {
  if (contribution.source === "mutation") {
    return ["Inspect the selected contracts.", "Add or strengthen assertions that kill this mutation.", "Rerun `visual-hive mutate`."];
  }
  if (contribution.status === "blocked") {
    return ["Resolve blocked evidence collection.", "Rerun `visual-hive evidence`.", "Generate a fresh handoff dry-run."];
  }
  return ["Reproduce the deterministic failure.", "Inspect linked artifacts.", "Repair the app or update reviewed baselines intentionally.", "Rerun Visual Hive."];
}

function blockedReasonsFor(evidence: EvidencePacket, mode: string, beadTarget: ReturnType<typeof beadTargetFor>): string[] {
  const reasons = [...evidence.hiveReadiness.blockedReasons];
  if (mode !== "dry_run") {
    reasons.push("Only dry-run handoff is implemented locally; trusted issue/API writes are deferred.");
  }
  if (mode === "bead_api" && !beadTarget.integrationEnabled) {
    reasons.push("Hive integration is disabled; enable integrations.hive only in a trusted workflow before creating Hive Beads.");
  }
  if (mode === "bead_api" && !beadTarget.beadApiUrl) {
    reasons.push("Hive bead API URL is not configured; set integrations.hive.beadApi.url in a trusted environment.");
  }
  if (mode === "bead_api" && !beadTarget.tokenPresent) {
    reasons.push(`Hive bead API token environment variable is missing: ${beadTarget.tokenEnv}.`);
  }
  if (!evidence.evidenceContributions.length) {
    reasons.push("Evidence Packet has no evidence contributions.");
  }
  return dedupe(reasons);
}

function beadTargetFor(options: BuildHandoffOptions, mode: HandoffMode): HiveBeadDryRunRequest["target"] {
  const tokenEnv = options.hiveIntegration?.beadApi?.tokenEnv ?? "HIVE_DASHBOARD_TOKEN";
  const tokenPresent = Boolean(options.hiveIntegration?.beadApi?.tokenPresent);
  const target = {
    integrationEnabled: Boolean(options.hiveIntegration?.enabled),
    configuredMode: options.hiveIntegration?.mode ?? mode,
    beadApiUrl: options.hiveIntegration?.beadApi?.url,
    tokenEnv,
    tokenPresent,
    missingTokenEnv: tokenPresent ? undefined : tokenEnv
  };
  return sanitizeValue(target) as HiveBeadDryRunRequest["target"];
}

function objectiveFor(evidence: EvidencePacket): string {
  const verdict = evidence.verdictSummary.visualHiveVerdict;
  if (verdict === "failed") return `Repair Visual Hive deterministic failures for ${evidence.project}.`;
  if (verdict === "blocked") return `Unblock Visual Hive evidence collection for ${evidence.project}.`;
  if (verdict === "warning") return `Review Visual Hive warnings and coverage guidance for ${evidence.project}.`;
  if (verdict === "inconclusive") return `Collect sufficient Visual Hive evidence for ${evidence.project}.`;
  return `Review passing Visual Hive evidence and improve coverage for ${evidence.project}.`;
}

function issueTitleFor(evidence: EvidencePacket): string {
  return `[Visual Hive] ${evidence.project} ${evidence.verdictSummary.visualHiveVerdict} evidence handoff`;
}

function dedupeSignature(evidence: EvidencePacket): string {
  const basis = [evidence.project, evidence.repo.repository ?? "local", evidence.verdictSummary.visualHiveVerdict, ...evidence.verdictSummary.failedBecause].join("|");
  let hash = 0;
  for (let index = 0; index < basis.length; index += 1) {
    hash = (hash * 31 + basis.charCodeAt(index)) >>> 0;
  }
  return `visual-hive-${hash.toString(16)}`;
}

function listContributions(contributions: EvidenceContribution[]): string[] {
  if (!contributions.length) return ["- None"];
  return contributions.map((contribution) => `- [${contribution.status}] ${contributionKey(contribution)}: ${contribution.reason}`);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => sanitizeText(value)))];
}

function dedupeWorkItems(items: HandoffWorkItem[]): HandoffWorkItem[] {
  const seen = new Set<string>();
  const result: HandoffWorkItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeArtifactPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function resolve(rootDir: string, artifactPath: string): string {
  return path.isAbsolute(artifactPath) ? artifactPath : path.resolve(rootDir, artifactPath);
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]));
  }
  return value;
}
