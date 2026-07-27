import crypto from "node:crypto";
import path from "node:path";
import { readJson, writeJson, writeText } from "../utils/files.js";
import { sanitizeArtifactPathForIssue, sanitizeArtifactPathsForMarkdown, sanitizeText } from "../utils/sanitize.js";
import type { MutationReport, Report, TriageReport } from "../reports/types.js";
import { writeVisualGraphArtifacts } from "../graph/build.js";
import type { RepoMapReport } from "../repo/types.js";
import type { TestCreationPlan } from "../testCreation/types.js";
import type { VisualHiveIssueCandidate, VisualHiveIssueQueue, VisualHiveIssuesReport, VisualHiveIssueSuppression, VisualHiveSetupIssue } from "./types.js";

type JsonObject = Record<string, unknown>;

const DEFAULT_GUARDRAILS = [
  "Visual Hive does not repair code; it detects, proves, packages, and routes this finding.",
  "Hive or an agent may act only from a trusted issue or handoff artifact.",
  "Do not approve baselines blindly.",
  "Do not weaken screenshot thresholds, selector contracts, or mutation thresholds to make the issue disappear.",
  "Rerun the listed Visual Hive validation command before marking the issue resolved."
];

const DEFAULT_LABELS = ["visual-hive", "hive/quality", "visual-hive/live", "visual-hive/ready-for-hive"];
const ISSUE_QUEUE_LABELS = [
  "visual-hive",
  "visual-hive/ready",
  "visual-hive/live",
  "visual-hive/still-active",
  "visual-hive/ready-for-hive",
  "visual-hive/blocked",
  "visual-hive/resolved-candidate",
  "visual-hive/agent-setup",
  "visual-hive/agent-map",
  "visual-hive/agent-test-creator",
  "visual-hive/agent-test-maintainer",
  "visual-hive/agent-mutation",
  "hive/quality",
  "hive/ci",
  "hive/architect",
  "mutation-survivor",
  "missing-coverage",
  "visual-regression",
  "map-drift",
  "stale-baseline"
];

export interface BuildIssuesOptions {
  rootDir: string;
  project?: string;
  now?: Date;
  sourcePaths?: Partial<VisualHiveIssuesReport["sourceArtifacts"]>;
  suppressionPath?: string;
}

export interface WriteIssuesOptions extends BuildIssuesOptions {
  issuesPath?: string;
  markdownPath?: string;
  queuePath?: string;
  setupIssuePath?: string;
}

export async function buildIssuesReport(options: BuildIssuesOptions): Promise<{ report: VisualHiveIssuesReport; markdown: string; queue: VisualHiveIssueQueue; setupIssue: VisualHiveSetupIssue }> {
  const rootDir = path.resolve(options.rootDir);
  const sourceArtifacts = defaultSourceArtifacts(options.sourcePaths);
  const [report, mutationReport, triage, coverage, coverageRecommendations, repoMap, visualGraph, visualImpact, workflows, readiness, evidencePacket, handoff, uxScoutResult, hiveExport, knowledgeGraph, agentPacket, testCreationPlan, previousIssues, suppressions] =
    await Promise.all([
      readOptional<Report>(rootDir, sourceArtifacts.report),
      readOptional<MutationReport>(rootDir, sourceArtifacts.mutationReport),
      readOptional<TriageReport>(rootDir, sourceArtifacts.triage),
      readOptional<JsonObject>(rootDir, sourceArtifacts.coverage),
      readOptional<JsonObject>(rootDir, sourceArtifacts.coverageRecommendations),
      readOptional<JsonObject>(rootDir, sourceArtifacts.repoMap),
      readOptional<JsonObject>(rootDir, sourceArtifacts.visualGraph),
      readOptional<JsonObject>(rootDir, sourceArtifacts.visualImpact),
      readOptional<JsonObject>(rootDir, sourceArtifacts.workflows),
      readOptional<JsonObject>(rootDir, sourceArtifacts.readiness),
      readOptional<JsonObject>(rootDir, sourceArtifacts.evidencePacket),
      readOptional<JsonObject>(rootDir, sourceArtifacts.handoff),
      readOptional<JsonObject>(rootDir, sourceArtifacts.uxScoutResult),
      readOptional<JsonObject>(rootDir, sourceArtifacts.hiveExport),
      readOptional<JsonObject>(rootDir, sourceArtifacts.knowledgeGraph),
      readOptional<JsonObject>(rootDir, sourceArtifacts.agentPacket),
      readOptional<TestCreationPlan>(rootDir, sourceArtifacts.testCreationPlan),
      readOptional<VisualHiveIssuesReport>(rootDir, ".visual-hive/issues.json"),
      readSuppressions(rootDir, options.suppressionPath ?? ".visual-hive/issue-suppressions.json")
    ]);
  const project = options.project ?? report?.project ?? readString(evidencePacket, "project") ?? "unknown";
  const generatedAt = (options.now ?? new Date()).toISOString();
  const current = [
    ...issuesFromReport(report, sourceArtifacts),
    ...issuesFromMutation(mutationReport, sourceArtifacts),
    ...issuesFromTriage(triage, sourceArtifacts),
    ...issuesFromCoverage(coverage, coverageRecommendations, sourceArtifacts),
    ...issuesFromRepoMap(repoMap, sourceArtifacts),
    ...issuesFromWorkflows(workflows, sourceArtifacts),
    ...issuesFromReadiness(readiness, sourceArtifacts),
    ...issuesFromProviderEvidence(evidencePacket, sourceArtifacts),
    ...issuesFromHandoff(handoff, sourceArtifacts),
    ...issuesFromTestCreation(testCreationPlan, sourceArtifacts)
  ];

  const previousByFingerprint = new Map((previousIssues?.issues ?? []).map((issue) => [issue.dedupeFingerprint, issue]));
  const keyed = new Map<string, VisualHiveIssueCandidate>();
  for (const issue of current) {
    const candidate = normalizeIssue(issue, rootDir, project, {
      evidencePacket: exists(sourceArtifacts.evidencePacket, evidencePacket),
      repoMap: exists(sourceArtifacts.repoMap, repoMap),
      visualGraph: exists(sourceArtifacts.visualGraph, visualGraph),
      visualImpact: exists(sourceArtifacts.visualImpact, visualImpact),
      mutationReport: exists(sourceArtifacts.mutationReport, mutationReport),
      handoff: exists(sourceArtifacts.handoff, handoff),
      hiveExport: exists(sourceArtifacts.hiveExport, hiveExport),
      knowledgeGraph: exists(sourceArtifacts.knowledgeGraph, knowledgeGraph),
      agentPacket: exists(sourceArtifacts.agentPacket, agentPacket)
    });
    const previous = previousByFingerprint.get(candidate.dedupeFingerprint);
    if (previous && previous.status !== "resolved_candidate" && previous.status !== "suppressed") {
      candidate.status = "update_candidate";
      candidate.labels = dedupe([...candidate.labels, "visual-hive/still-active"]);
      candidate.body = renderIssueBody(candidate, issueSummary(candidate.body), rootDir);
    }
    keyed.set(candidate.dedupeFingerprint, candidate);
  }

  for (const previous of previousIssues?.issues ?? []) {
    if (!keyed.has(previous.dedupeFingerprint) && previous.status !== "resolved_candidate" && previous.status !== "suppressed") {
      keyed.set(previous.dedupeFingerprint, {
        ...previous,
        status: "resolved_candidate",
        labels: dedupe([...previous.labels, "visual-hive/resolved-candidate"]),
        body: renderIssueBody({
          ...previous,
          status: "resolved_candidate",
          labels: dedupe([...previous.labels, "visual-hive/resolved-candidate"]),
          sourceArtifacts: dedupe([...previous.sourceArtifacts, sourceArtifacts.evidencePacket ?? ".visual-hive/evidence-packet.json"]),
          guardrails: DEFAULT_GUARDRAILS,
          validationCommand: previous.validationCommand || "visual-hive evidence && visual-hive issues --write"
        }, undefined, rootDir)
      });
    }
  }

  const suppressionByFingerprint = new Map(suppressions.map((entry) => [entry.dedupeFingerprint, entry]));
  const issues = [...keyed.values()]
    .map((issue) => applySuppression(issue, suppressionByFingerprint.get(issue.dedupeFingerprint)))
    .sort(compareIssues);

  const issuesReport: VisualHiveIssuesReport = sanitizeValue({
    schemaVersion: "visual-hive.issues.v1",
    generatedAt,
    project,
    externalCallsMade: 0,
    networkCallsMade: 0,
    sourceArtifacts: presentSourceArtifacts(rootDir, sourceArtifacts, {
      report,
      mutationReport,
      triage,
      coverage,
      coverageRecommendations,
      repoMap,
      visualGraph,
      visualImpact,
      workflows,
      readiness,
      evidencePacket,
      handoff,
      uxScoutResult,
      hiveExport,
      knowledgeGraph,
      agentPacket,
      testCreationPlan
    }),
    summary: summarizeIssues(issues),
    issues
  }) as VisualHiveIssuesReport;
  const queue = buildIssueQueue(issuesReport, generatedAt);
  const setupIssue = buildSetupIssue({ project, generatedAt, sourceArtifacts: issuesReport.sourceArtifacts, repoMap, readiness, rootDir });
  return {
    report: issuesReport,
    markdown: renderIssuesMarkdown(issuesReport),
    queue,
    setupIssue
  };
}

export async function writeIssuesArtifacts(options: WriteIssuesOptions): Promise<{
  report: VisualHiveIssuesReport;
  markdown: string;
  queue: VisualHiveIssueQueue;
  setupIssue: VisualHiveSetupIssue;
  issuesPath: string;
  markdownPath: string;
  queuePath: string;
  setupIssuePath: string;
}> {
  const built = await buildIssuesReport(options);
  const issuesPath = resolve(options.rootDir, options.issuesPath ?? ".visual-hive/issues.json");
  const markdownPath = resolve(options.rootDir, options.markdownPath ?? ".visual-hive/issues.md");
  const queuePath = resolve(options.rootDir, options.queuePath ?? ".visual-hive/issue-queue.json");
  const setupIssuePath = resolve(options.rootDir, options.setupIssuePath ?? ".visual-hive/setup-issue.md");
  await writeJson(issuesPath, built.report);
  await writeText(markdownPath, built.markdown);
  await writeJson(queuePath, built.queue);
  await writeText(setupIssuePath, built.setupIssue.body);
  await refreshVisualGraphWithIssues(options.rootDir, built.report);
  return { ...built, issuesPath, markdownPath, queuePath, setupIssuePath };
}

export function buildIssueQueue(report: VisualHiveIssuesReport, generatedAt = new Date().toISOString()): VisualHiveIssueQueue {
  const readyForHive = report.issues.filter((issue) => issue.status === "open_candidate" || issue.status === "update_candidate");
  const readyForAgent = readyForHive.filter((issue) => !issue.sourceArtifacts.some((artifact) => artifact.includes("missing")));
  const blockedPolicy = report.issues.filter((issue) => issue.status === "blocked");
  const blockedMissingArtifact = report.issues.filter((issue) => issue.status !== "suppressed" && issue.status !== "resolved_candidate" && !issue.linkedEvidencePacket);
  const resolved = report.issues.filter((issue) => issue.status === "resolved_candidate");
  const suppressed = report.issues.filter((issue) => issue.status === "suppressed");
  return sanitizeValue({
    schemaVersion: "visual-hive.issue-queue.v1",
    generatedAt,
    project: report.project,
    externalCallsMade: 0,
    networkCallsMade: 0,
    summary: {
      total: report.issues.length,
      readyForHive: readyForHive.length,
      readyForVisualHiveAgent: readyForAgent.length,
      blockedPolicy: blockedPolicy.length,
      blockedMissingArtifact: blockedMissingArtifact.length,
      resolvedCandidates: resolved.length,
      suppressed: suppressed.length
    },
    labels: ISSUE_QUEUE_LABELS,
    queues: {
      ready_for_hive: readyForHive,
      ready_for_visual_hive_agent: readyForAgent,
      blocked_policy: blockedPolicy,
      blocked_missing_artifact: blockedMissingArtifact,
      resolved_candidate: resolved,
      suppressed
    }
  }) as VisualHiveIssueQueue;
}

export function renderIssuesMarkdown(report: VisualHiveIssuesReport): string {
  const lines = [
    `# Visual Hive Issue Candidates: ${report.project}`,
    "",
    "Visual Hive does not repair code. These issue candidates are deterministic evidence packets for humans, Hive, and agents.",
    "",
    `- Total: ${report.summary.total}`,
    `- Open candidates: ${report.summary.openCandidates}`,
    `- Update candidates: ${report.summary.updateCandidates}`,
    `- Resolved candidates: ${report.summary.resolvedCandidates}`,
    `- Suppressed: ${report.summary.suppressed}`,
    `- External calls made: ${report.externalCallsMade}`,
    "",
    "## Candidates"
  ];
  for (const issue of report.issues) {
    lines.push(
      "",
      `### ${issue.title}`,
      "",
      `- Kind: ${issue.issueKind}`,
      `- Severity: ${issue.severity}`,
      `- Status: ${issue.status}`,
      `- Dedupe: ${issue.dedupeFingerprint}`,
      `- Agent: ${issue.owningAgentHint}`,
      `- Labels: ${issue.labels.join(", ")}`,
      `- Validation: \`${issue.validationCommand}\``,
      "",
      issue.body
    );
  }
  return `${sanitizeText(lines.join("\n"))}\n`;
}

function issuesFromReport(report: Report | undefined, sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"]): VisualHiveIssueCandidate[] {
  if (!report) return [];
  const issues: VisualHiveIssueCandidate[] = [];
  for (const result of report.results ?? []) {
    if (result.status !== "failed") continue;
    const hasSelectorFailure = result.selectorAssertions?.some((assertion) => assertion.status === "failed");
    const hasScreenshotFailure = result.screenshotAssertions?.some((shot) => shot.status === "failed" || shot.status === "missing_baseline");
    issues.push(baseIssue({
      issueKind: hasSelectorFailure ? "selector_contract_failure" : hasScreenshotFailure ? "screenshot_diff" : "visual_regression",
      severity: reportSeverity(result.errors, "high"),
      title: `[Visual Hive] ${result.contractId} failed deterministic validation`,
      labels: ["visual-regression"],
      owningAgentHint: hasSelectorFailure ? "visual-hive/test-maintainer" : "hive/quality",
      sourceArtifacts: [sourceArtifacts.report ?? ".visual-hive/report.json"],
      affected: [
        {
          contractId: result.contractId,
          targetId: result.targetId,
          selector: result.selectorAssertions?.find((assertion) => assertion.status === "failed")?.value,
          route: result.screenshotAssertions?.[0]?.route,
          viewport: result.screenshotAssertions?.[0]?.viewport
        }
      ],
      reproductionCommand: result.reproductionCommand,
      validationCommand: result.reproductionCommand ?? "visual-hive run --ci && visual-hive evidence",
      bodySummary: `${result.contractId} failed with ${result.errors.length} error(s). ${result.errors.slice(0, 3).join(" ")}`
    }));
  }
  for (const result of report.results ?? []) {
    for (const shot of result.screenshotAssertions ?? []) {
      if (shot.status === "created" || shot.status === "missing_baseline") {
        issues.push(baseIssue({
          issueKind: shot.status === "created" ? "stale_baseline" : "screenshot_diff",
          severity: shot.status === "missing_baseline" ? "high" : "medium",
          title: `[Visual Hive] Review ${shot.status === "created" ? "created" : "missing"} baseline for ${shot.contractId}/${shot.screenshotName}`,
          labels: ["stale-baseline"],
          owningAgentHint: "visual-hive/test-maintainer",
          sourceArtifacts: [sourceArtifacts.report ?? ".visual-hive/report.json", shot.actualPath, shot.baselinePath, shot.diffPath].filter((artifact): artifact is string => Boolean(artifact)),
          affected: [{ contractId: shot.contractId, route: shot.route, viewport: shot.viewport }],
          reproductionCommand: result.reproductionCommand,
          validationCommand: "visual-hive baselines list --write && visual-hive run --ci",
          bodySummary: `Screenshot ${shot.screenshotName} on ${shot.viewport} reported baseline status ${shot.status}. Baseline review must be explicit.`
        }));
      }
    }
  }
  return issues;
}

function issuesFromMutation(report: MutationReport | undefined, sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"]): VisualHiveIssueCandidate[] {
  if (!report) return [];
  return (report.results ?? [])
    .filter((result) => result.status === "survived")
    .map((result) =>
      baseIssue({
        issueKind: "mutation_survivor",
        severity: "high",
        title: `[Visual Hive] Mutation survived: ${result.operator}`,
        labels: ["mutation-survivor", "missing-coverage"],
        owningAgentHint: "visual-hive/mutation",
        sourceArtifacts: [sourceArtifacts.mutationReport ?? ".visual-hive/mutation-report.json", ...(result.artifacts ?? [])],
        affected: (result.affectedSurfaces ?? result.affected ?? []).map((surface) => ({
          contractId: surface.contractId,
          targetId: surface.targetId,
          route: surface.route,
          component: surface.component,
          viewport: surface.viewport
        })),
        reproductionCommand: result.validationCommand,
        validationCommand: result.validationCommand ?? "visual-hive mutate --enforce-min-score",
        bodySummary: result.failedAssertion ?? result.suggestedMissingTest ?? `${result.operator} survived; add or strengthen a contract so the mutation is killed.`
      })
    );
}

function issuesFromTriage(report: TriageReport | undefined, sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"]): VisualHiveIssueCandidate[] {
  if (!report) return [];
  return (report.findings ?? [])
    .filter((finding) => ["coverage_gap", "insufficient_coverage", "provider_failure", "protected_target_missing_secret", "external_upload_blocked"].includes(finding.classification))
    .map((finding) =>
      baseIssue({
        issueKind: finding.classification.includes("coverage") ? "missing_visual_coverage" : finding.classification === "protected_target_missing_secret" ? "protected_target_blocked" : "provider_governance",
        severity: finding.severity,
        title: `[Visual Hive] ${finding.title}`,
        labels: finding.classification.includes("coverage") ? ["missing-coverage"] : ["visual-hive/blocked"],
        owningAgentHint: finding.classification.includes("coverage") ? "visual-hive/test-creator" : "hive/ci",
        sourceArtifacts: [sourceArtifacts.triage ?? ".visual-hive/triage.json"],
        affected: (finding.contractIds ?? []).map((contractId) => ({ contractId })),
        validationCommand: "visual-hive triage && visual-hive issues --write",
        bodySummary: finding.evidence.join("\n")
      })
    );
}

function issuesFromCoverage(coverage: JsonObject | undefined, recommendations: JsonObject | undefined, sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"]): VisualHiveIssueCandidate[] {
  const rows = arrayOfObjects(recommendations?.recommendations);
  const maintenance = arrayOfObjects(recommendations?.maintenanceFindings);
  const issues: VisualHiveIssueCandidate[] = rows.slice(0, 12).map((row) =>
    baseIssue({
      issueKind: "missing_visual_coverage",
      severity: severityFromString(readString(row, "priority") ?? readString(row, "severity"), "medium"),
      title: `[Visual Hive] Add visual coverage: ${readString(row, "title") ?? readString(row, "id") ?? "coverage recommendation"}`,
      labels: ["missing-coverage"],
      owningAgentHint: "visual-hive/test-creator",
      sourceArtifacts: [sourceArtifacts.coverageRecommendations ?? ".visual-hive/coverage-recommendations.json", sourceArtifacts.coverage ?? ".visual-hive/coverage.json"],
      affected: [{ contractId: readString(row, "contractId"), targetId: readString(row, "targetId") }],
      validationCommand: "visual-hive improve-coverage && visual-hive issues --write",
      bodySummary: readString(row, "description") ?? readString(row, "rationale") ?? JSON.stringify(row).slice(0, 800)
    })
  );
  for (const finding of maintenance.slice(0, 12)) {
    issues.push(
      baseIssue({
        issueKind: maintenanceKind(readString(finding, "kind")),
        severity: severityFromString(readString(finding, "severity"), "medium"),
        title: `[Visual Hive] Maintain visual test: ${readString(finding, "title") ?? readString(finding, "kind") ?? "maintenance finding"}`,
        labels: ["visual-hive/agent-test-maintainer"],
        owningAgentHint: "visual-hive/test-maintainer",
        sourceArtifacts: [sourceArtifacts.coverageRecommendations ?? ".visual-hive/coverage-recommendations.json"],
        affected: [{ contractId: readString(finding, "contractId"), route: readString(finding, "route"), viewport: readString(finding, "viewport") }],
        validationCommand: "visual-hive improve-coverage && visual-hive issues --write",
        bodySummary: readString(finding, "description") ?? JSON.stringify(finding).slice(0, 800)
      })
    );
  }
  if (!coverage && !recommendations) return [];
  return issues;
}

function issuesFromRepoMap(repoMap: JsonObject | undefined, sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"]): VisualHiveIssueCandidate[] {
  const gaps = arrayOfObjects(repoMap?.coverageGaps).concat(arrayOfObjects(repoMap?.mapFindings));
  return gaps.slice(0, 10).map((gap) =>
    baseIssue({
      issueKind: readString(gap, "kind")?.includes("map") ? "map_drift" : "missing_visual_coverage",
      severity: severityFromString(readString(gap, "severity"), "medium"),
      title: `[Visual Hive] Repo map finding: ${readString(gap, "title") ?? readString(gap, "kind") ?? "coverage gap"}`,
      labels: ["map-drift"],
      owningAgentHint: "visual-hive/map",
      sourceArtifacts: [sourceArtifacts.repoMap ?? ".visual-hive/repo-map.json"],
      affected: [{ route: readString(gap, "route"), component: readString(gap, "component"), selector: readString(gap, "selector") }],
      validationCommand: "visual-hive analyze --repo . && visual-hive issues --write",
      bodySummary: readString(gap, "description") ?? JSON.stringify(gap).slice(0, 800)
    })
  );
}

function issuesFromWorkflows(workflows: JsonObject | undefined, sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"]): VisualHiveIssueCandidate[] {
  const findings = arrayOfObjects(workflows?.findings);
  return findings.slice(0, 10).map((finding) =>
    baseIssue({
      issueKind: "workflow_safety",
      severity: severityFromString(readString(finding, "severity"), readString(finding, "level") === "critical" ? "critical" : "high"),
      title: `[Visual Hive] Workflow safety finding: ${readString(finding, "title") ?? readString(finding, "id") ?? "workflow safety"}`,
      labels: ["visual-hive/blocked", "hive/ci"],
      owningAgentHint: "hive/ci",
      sourceArtifacts: [sourceArtifacts.workflows ?? ".visual-hive/workflows.json"],
      affected: [],
      validationCommand: "visual-hive workflows && visual-hive security",
      bodySummary: readString(finding, "message") ?? JSON.stringify(finding).slice(0, 800)
    })
  );
}

function issuesFromReadiness(readiness: JsonObject | undefined, sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"]): VisualHiveIssueCandidate[] {
  const blockers = readStringArray(readiness?.blockedReasons).concat(readStringArray(readiness?.warnings));
  return blockers.slice(0, 10).map((reason) =>
    baseIssue({
      issueKind: reason.toLowerCase().includes("setup") ? "setup_needed" : "external_repo_onboarding",
      severity: reason.toLowerCase().includes("blocked") ? "high" : "medium",
      title: `[Visual Hive] Readiness action: ${reason.slice(0, 80)}`,
      labels: ["visual-hive/blocked"],
      owningAgentHint: "visual-hive/setup",
      sourceArtifacts: [sourceArtifacts.readiness ?? ".visual-hive/readiness.json"],
      affected: [],
      validationCommand: "visual-hive readiness && visual-hive issues --write",
      bodySummary: reason
    })
  );
}

function issuesFromProviderEvidence(evidence: JsonObject | undefined, sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"]): VisualHiveIssueCandidate[] {
  const providers = arrayOfObjects(evidence?.providers);
  return providers
    .filter((provider) => ["failed", "missing_credentials", "blocked"].includes(readString(provider, "status") ?? readString(objectValue(provider, "upload"), "status") ?? ""))
    .map((provider) =>
      baseIssue({
        issueKind: "provider_governance",
        severity: readString(provider, "status") === "failed" ? "high" : "medium",
        title: `[Visual Hive] Provider governance: ${readString(provider, "providerId") ?? "provider"} ${readString(provider, "status") ?? "needs review"}`,
        labels: ["visual-hive/blocked"],
        owningAgentHint: "hive/ci",
        sourceArtifacts: [sourceArtifacts.evidencePacket ?? ".visual-hive/evidence-packet.json", ".visual-hive/provider-results.json"],
        affected: [],
        validationCommand: "visual-hive providers list && visual-hive issues --write",
        bodySummary: readString(provider, "message") ?? JSON.stringify(provider).slice(0, 800)
      })
    );
}

function issuesFromHandoff(handoff: JsonObject | undefined, sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"]): VisualHiveIssueCandidate[] {
  const workItems = arrayOfObjects(handoff?.workItems);
  return workItems
    .filter((item) => readString(item, "priority") === "critical" || readString(item, "priority") === "high")
    .slice(0, 10)
    .map((item) => {
      const contractId = workItemContractId(item);
      return baseIssue({
        issueKind: readString(item, "kind") === "test_creation" ? "missing_visual_coverage" : "external_repo_onboarding",
        severity: severityFromString(readString(item, "priority"), "medium"),
        title: `[Visual Hive] Handoff work item: ${readString(item, "title") ?? readString(item, "id") ?? "agent work"}`,
        labels: ["visual-hive/ready"],
        owningAgentHint: readString(item, "kind") === "test_creation" ? "visual-hive/test-creator" : "hive/quality",
        sourceArtifacts: [sourceArtifacts.handoff ?? ".visual-hive/handoff.json", ...readStringArray(item.artifacts)],
        affected: contractId ? [{ contractId }] : [],
        validationCommand: "visual-hive handoff-validate && visual-hive issues --write",
        bodySummary: readString(item, "summary") ?? JSON.stringify(item).slice(0, 800)
      });
    });
}

function issuesFromTestCreation(plan: TestCreationPlan | undefined, sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"]): VisualHiveIssueCandidate[] {
  if (!plan) return [];
  return plan.recommendations
    .filter((recommendation) => recommendation.source === "testing_layer" && recommendation.kind === "unit_test")
    .filter((recommendation) => recommendation.priority === "high" || recommendation.priority === "medium")
    .slice(0, 1)
    .map((recommendation) =>
      baseIssue({
        issueKind: "test_adequacy_gap",
        severity: "high",
        title: `[Visual Hive] Add repository test coverage: ${recommendation.title}`,
        labels: ["missing-coverage", "test-adequacy-gap"],
        owningAgentHint: "visual-hive/test-creator",
        sourceArtifacts: [sourceArtifacts.testCreationPlan ?? ".visual-hive/test-creation-plan.json", ...recommendation.artifacts],
        affected: [
          { route: recommendation.affected.route, component: recommendation.affected.component },
          { contractId: `testing-layer:${recommendation.layer?.id ?? 2}` }
        ],
        validationCommand: "node --test && visual-hive analyze --repo . && visual-hive test-creation-plan && visual-hive issues --write",
        bodySummary: [
          ...recommendation.rationale,
          ...recommendation.suggestedTests,
          "Repair scope: add focused repository test files only; do not change source, package metadata, workflows, Visual Hive config, or baselines."
        ].join("\n")
      })
    );
}

function workItemContractId(item: JsonObject): string | undefined {
  const explicit = readString(item, "contractId");
  if (explicit) return explicit;
  const id = readString(item, "id");
  if (!id) return undefined;
  for (const prefix of ["playwright.contract_result.", "playwright.console_error.", "playwright.page_error.", "screenshot_diff.missing_baseline.", "screenshot_diff.failed."]) {
    if (id.startsWith(prefix)) {
      return id.slice(prefix.length) || undefined;
    }
  }
  return undefined;
}

function baseIssue(input: Omit<VisualHiveIssueCandidate, "status" | "dedupeFingerprint" | "body" | "labels" | "guardrails" | "validationCommand"> & {
  labels?: string[];
  validationCommand?: string;
  bodySummary: string;
}): VisualHiveIssueCandidate {
  const labels = dedupe([...DEFAULT_LABELS, ...agentLabels(input.owningAgentHint), ...(input.labels ?? []), input.issueKind.replaceAll("_", "-")]);
  const partial: VisualHiveIssueCandidate = {
    issueKind: input.issueKind,
    severity: input.severity,
    status: "open_candidate",
    dedupeFingerprint: legacyFingerprint(input.issueKind, input.title, input.affected),
    title: input.title,
    labels,
    body: "",
    owningAgentHint: input.owningAgentHint,
    sourceArtifacts: dedupe(input.sourceArtifacts),
    affected: input.affected.filter((surface) => Object.values(surface).some(Boolean)),
    reproductionCommand: input.reproductionCommand,
    validationCommand: input.validationCommand ?? "visual-hive issues --write",
    guardrails: DEFAULT_GUARDRAILS
  };
  partial.body = renderIssueBody(partial, input.bodySummary);
  return partial;
}

function normalizeIssue(issue: VisualHiveIssueCandidate, rootDir: string, project: string, links: Partial<Record<"evidencePacket" | "repoMap" | "visualGraph" | "visualImpact" | "mutationReport" | "handoff" | "hiveExport" | "knowledgeGraph" | "agentPacket", string>>): VisualHiveIssueCandidate {
  const surface = issue.affected[0]?.contractId ?? issue.affected[0]?.route ?? issue.affected[0]?.component ?? issue.issueKind;
  const normalized = {
    ...issue,
    dedupeFingerprint: fingerprint(project, issue.issueKind, surface, issue.title, issue.affected),
    linkedEvidencePacket: links.evidencePacket ? sanitizeArtifactPathForIssue(rootDir, links.evidencePacket) : undefined,
    linkedRepoMap: links.repoMap ? sanitizeArtifactPathForIssue(rootDir, links.repoMap) : undefined,
    linkedVisualGraph: links.visualGraph ? sanitizeArtifactPathForIssue(rootDir, links.visualGraph) : undefined,
    linkedVisualImpact: links.visualImpact ? sanitizeArtifactPathForIssue(rootDir, links.visualImpact) : undefined,
    linkedMutationReport: issue.issueKind === "mutation_survivor" && links.mutationReport ? sanitizeArtifactPathForIssue(rootDir, links.mutationReport) : issue.linkedMutationReport ? sanitizeArtifactPathForIssue(rootDir, issue.linkedMutationReport) : undefined,
    linkedHandoff: links.handoff ? sanitizeArtifactPathForIssue(rootDir, links.handoff) : undefined,
    linkedHiveExport: links.hiveExport ? sanitizeArtifactPathForIssue(rootDir, links.hiveExport) : undefined,
    linkedKnowledgeGraph: links.knowledgeGraph ? sanitizeArtifactPathForIssue(rootDir, links.knowledgeGraph) : undefined,
    linkedAgentPacket: links.agentPacket ? sanitizeArtifactPathForIssue(rootDir, links.agentPacket) : undefined
  };
  normalized.sourceArtifacts = dedupe([
    ...normalized.sourceArtifacts.map((artifact) => sanitizeArtifactPathForIssue(rootDir, artifact)),
    normalized.linkedEvidencePacket,
    normalized.linkedRepoMap,
    normalized.linkedVisualGraph,
    normalized.linkedVisualImpact,
    normalized.linkedMutationReport,
    normalized.linkedHandoff,
    normalized.linkedHiveExport,
    normalized.linkedKnowledgeGraph,
    normalized.linkedAgentPacket
  ]);
  normalized.body = renderIssueBody(normalized, issueSummary(issue.body), rootDir);
  return sanitizeValue(normalized) as VisualHiveIssueCandidate;
}

function issueSummary(body: string): string | undefined {
  const evidenceMarker = "\n## Visual Hive Evidence\n";
  const evidenceIndex = body.indexOf(evidenceMarker);
  if (evidenceIndex < 0) return undefined;
  const headingEnd = body.indexOf("\n", body.indexOf("\n# ") + 1);
  if (headingEnd < 0 || headingEnd >= evidenceIndex) return undefined;
  return body.slice(headingEnd, evidenceIndex).trim() || undefined;
}

function renderIssueBody(issue: VisualHiveIssueCandidate, bodySummary?: string, rootDir?: string): string {
  const linkedArtifacts = dedupe([
    issue.linkedEvidencePacket,
    issue.linkedRepoMap,
    issue.linkedVisualGraph,
    issue.linkedVisualImpact,
    issue.linkedMutationReport,
    issue.linkedHandoff,
    issue.linkedHiveExport,
    issue.linkedKnowledgeGraph,
    issue.linkedAgentPacket,
    ...issue.sourceArtifacts
  ]).map((artifact) => (rootDir ? sanitizeArtifactPathForIssue(rootDir, artifact) : artifact));
  const lines = [
    `<!-- visual-hive-issue dedupe:${issue.dedupeFingerprint} -->`,
    `<!-- visual-hive-issue-kind:${issue.issueKind} -->`,
    "",
    `# ${issue.title}`,
    "",
    bodySummary ?? "",
    "",
    "## Visual Hive Evidence",
    "",
    `- Issue kind: ${issue.issueKind}`,
    `- Severity: ${issue.severity}`,
    `- Status: ${issue.status}`,
    `- Owning agent hint: ${issue.owningAgentHint}`,
    `- Dedupe fingerprint: ${issue.dedupeFingerprint}`,
    issue.reproductionCommand ? `- Reproduction command: \`${issue.reproductionCommand}\`` : undefined,
    `- Validation command: \`${issue.validationCommand}\``,
    "",
    "## Linked Artifacts",
    "",
    ...linkedArtifacts.map((artifact) => `- ${artifact}`),
    "",
    "## Affected Surface",
    "",
    ...(issue.affected.length ? issue.affected.map((surface) => `- ${Object.entries(surface).filter(([, value]) => Boolean(value)).map(([key, value]) => `${key}=${value}`).join(", ")}`) : ["- No specific route/component/selector recorded."]),
    "",
    "## Guardrails",
    "",
    ...issue.guardrails.map((guardrail) => `- ${guardrail}`),
    "",
    ...(issue.status === "resolved_candidate"
      ? [
          "## Resolved Candidate Evidence",
          "",
          "Visual Hive no longer detects this finding in the latest artifact set. Treat this as deterministic resolved-candidate evidence for a trusted workflow or human reviewer.",
          "",
          "Do not auto-close by default unless repository policy explicitly enables auto-close. Prefer updating the existing issue with this evidence and adding `visual-hive/resolved-candidate`."
        ]
      : []),
    "",
    "## Agent Direction",
    "",
    "Visual Hive validates; Hive repairs. Hive and agents should use this issue as the queue item, then rerun the listed Visual Hive validation command after any proposed fix."
  ].filter((line): line is string => line !== undefined);
  const body = lines.join("\n");
  return rootDir ? sanitizeArtifactPathsForMarkdown(rootDir, body) : sanitizeText(body);
}

function buildSetupIssue(input: { project: string; generatedAt: string; sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"]; repoMap?: JsonObject; readiness?: JsonObject; rootDir: string }): VisualHiveSetupIssue {
  const artifacts = Object.values(input.sourceArtifacts).filter(Boolean).map((artifact) => sanitizeArtifactPathForIssue(input.rootDir, artifact));
  const body = sanitizeArtifactPathsForMarkdown(input.rootDir, [
    "<!-- visual-hive-setup-issue -->",
    "# [Visual Hive] Setup visual QA",
    "",
    `Project: ${input.project}`,
    "",
    "Visual Hive detected this repository as a candidate for deterministic visual QA orchestration.",
    "",
    "## Setup Checklist",
    "",
    "- [ ] Confirm app build and local preview commands.",
    "- [ ] Add stable route-level and component-level selectors.",
    "- [ ] Add `visual-hive.config.yaml` targets and contracts.",
    "- [ ] Seed baselines locally and review them explicitly.",
    "- [ ] Enable PR-safe workflow with read-only permissions and no secrets.",
    "- [ ] Enable trusted issue handoff only after artifact validation.",
    "",
    "## Evidence",
    "",
    ...artifacts.map((artifact) => `- ${artifact}`),
    "",
    "## Commands",
    "",
    "```bash",
    "visual-hive doctor",
    "visual-hive analyze --repo .",
    "visual-hive recommend --repo .",
    "visual-hive plan --mode pr",
    "visual-hive issues --write",
    "```",
    "",
    "Visual Hive does not repair code or create pull requests from this setup issue. A setup agent may propose config/workflow changes in a reviewed branch."
  ].join("\n"));
  return {
    schemaVersion: "visual-hive.setup-issue.v1",
    generatedAt: input.generatedAt,
    project: input.project,
    title: "[Visual Hive] Setup visual QA",
    labels: ["visual-hive", "setup", "hive/quality"],
    body,
    externalCallsMade: 0,
    networkCallsMade: 0,
    sourceArtifacts: artifacts
  };
}

function applySuppression(issue: VisualHiveIssueCandidate, suppression?: VisualHiveIssueSuppression): VisualHiveIssueCandidate {
  if (!suppression) return issue;
  if (suppression.expiresAt && Date.parse(suppression.expiresAt) < Date.now()) return issue;
  return {
    ...issue,
    status: "suppressed",
    suppressedReason: suppression.reason,
    suppressionExpiresAt: suppression.expiresAt,
    body: `${issue.body}\n\n## Suppression\n\n- Reason: ${sanitizeText(suppression.reason)}${suppression.expiresAt ? `\n- Expires: ${sanitizeText(suppression.expiresAt)}` : ""}\n`
  };
}

function summarizeIssues(issues: VisualHiveIssueCandidate[]): VisualHiveIssuesReport["summary"] {
  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const issue of issues) {
    byKind[issue.issueKind] = (byKind[issue.issueKind] ?? 0) + 1;
    bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
  }
  return {
    total: issues.length,
    openCandidates: issues.filter((issue) => issue.status === "open_candidate").length,
    updateCandidates: issues.filter((issue) => issue.status === "update_candidate").length,
    resolvedCandidates: issues.filter((issue) => issue.status === "resolved_candidate").length,
    suppressed: issues.filter((issue) => issue.status === "suppressed").length,
    blocked: issues.filter((issue) => issue.status === "blocked").length,
    byKind,
    bySeverity
  };
}

function presentSourceArtifacts(rootDir: string, sourceArtifacts: VisualHiveIssuesReport["sourceArtifacts"], values: Record<string, unknown>): VisualHiveIssuesReport["sourceArtifacts"] {
  return Object.fromEntries(
    Object.entries(sourceArtifacts)
      .filter(([key, value]) => Boolean(value) && values[key] !== undefined)
      .map(([key, value]) => [key, value ? sanitizeArtifactPathForIssue(rootDir, value) : value])
  ) as VisualHiveIssuesReport["sourceArtifacts"];
}

function defaultSourceArtifacts(overrides?: Partial<VisualHiveIssuesReport["sourceArtifacts"]>): VisualHiveIssuesReport["sourceArtifacts"] {
  return {
    report: ".visual-hive/report.json",
    mutationReport: ".visual-hive/mutation-report.json",
    coverage: ".visual-hive/coverage.json",
    coverageRecommendations: ".visual-hive/coverage-recommendations.json",
    testCreationPlan: ".visual-hive/test-creation-plan.json",
    triage: ".visual-hive/triage.json",
    repoMap: ".visual-hive/repo-map.json",
    workflows: ".visual-hive/workflows.json",
    readiness: ".visual-hive/readiness.json",
    evidencePacket: ".visual-hive/evidence-packet.json",
    visualGraph: ".visual-hive/visual-graph.json",
    visualImpact: ".visual-hive/visual-impact.json",
    handoff: ".visual-hive/handoff.json",
    hiveExport: ".visual-hive/hive/hive-export.json",
    knowledgeGraph: ".visual-hive/hive/knowledge-graph.json",
    agentPacket: ".visual-hive/agent-packet.json",
    uxScoutResult: ".visual-hive/ux-scout-result.json",
    ...overrides
  };
}

async function readOptional<T>(rootDir: string, artifactPath?: string): Promise<T | undefined> {
  if (!artifactPath) return undefined;
  try {
    return sanitizeValue(await readJson<T>(resolve(rootDir, artifactPath))) as T;
  } catch {
    return undefined;
  }
}

async function readSuppressions(rootDir: string, artifactPath: string): Promise<VisualHiveIssueSuppression[]> {
  const parsed = await readOptional<{ suppressions?: VisualHiveIssueSuppression[] } | VisualHiveIssueSuppression[]>(rootDir, artifactPath);
  if (Array.isArray(parsed)) return parsed;
  return parsed?.suppressions ?? [];
}

async function refreshVisualGraphWithIssues(rootDir: string, issuesReport: VisualHiveIssuesReport): Promise<void> {
  const repoMap = await readOptional<RepoMapReport>(rootDir, ".visual-hive/repo-map.json");
  if (!isRepoMapReport(repoMap)) return;
  await writeVisualGraphArtifacts({ repoRoot: rootDir, repoMap, issuesReport });
}

function isRepoMapReport(value: unknown): value is RepoMapReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const visualMap = (value as { visualMap?: unknown }).visualMap;
  if (!visualMap || typeof visualMap !== "object" || Array.isArray(visualMap)) return false;
  const map = visualMap as { nodes?: unknown; edges?: unknown };
  return Array.isArray(map.nodes) && Array.isArray(map.edges);
}

function exists(pathValue?: string, object?: unknown): string | undefined {
  return pathValue && object ? pathValue : undefined;
}

function maintenanceKind(kind?: string): VisualHiveIssueCandidate["issueKind"] {
  if (!kind) return "weak_visual_test";
  if (kind.includes("baseline_churn")) return "baseline_churn";
  if (kind.includes("stale_baseline")) return "stale_baseline";
  if (kind.includes("missing")) return "missing_visual_coverage";
  return "weak_visual_test";
}

function reportSeverity(errors: string[], fallback: VisualHiveIssueCandidate["severity"]): VisualHiveIssueCandidate["severity"] {
  const joined = errors.join(" ").toLowerCase();
  if (joined.includes("critical") || joined.includes("login")) return "critical";
  return fallback;
}

function severityFromString(value: string | undefined, fallback: VisualHiveIssueCandidate["severity"]): VisualHiveIssueCandidate["severity"] {
  if (value === "critical" || value === "high" || value === "medium" || value === "low") return value;
  return fallback;
}

function agentLabels(agent: VisualHiveIssueCandidate["owningAgentHint"]): string[] {
  const map: Record<VisualHiveIssueCandidate["owningAgentHint"], string[]> = {
    "visual-hive/setup": ["visual-hive/agent-setup"],
    "visual-hive/map": ["visual-hive/agent-map", "map-drift"],
    "visual-hive/test-creator": ["visual-hive/agent-test-creator"],
    "visual-hive/test-maintainer": ["visual-hive/agent-test-maintainer"],
    "visual-hive/mutation": ["visual-hive/agent-mutation"],
    "hive/quality": ["hive/quality"],
    "hive/ci": ["hive/ci"],
    "hive/architect": ["hive/architect"]
  };
  return map[agent];
}

function fingerprint(project: string, kind: string, surface: string | undefined, title: string, affected: VisualHiveIssueCandidate["affected"]): string {
  const repo = safeFingerprintSegment(project);
  const surfaceSegment = safeFingerprintSegment(surface ?? "surface");
  const base = JSON.stringify({ repo, kind, surface: surfaceSegment, title: title.toLowerCase(), affected: fingerprintAffected(affected) });
  return `visual-hive:${repo}:${kind}:${surfaceSegment}:${crypto.createHash("sha256").update(base).digest("hex").slice(0, 16)}`;
}

function legacyFingerprint(kind: string, title: string, affected: VisualHiveIssueCandidate["affected"]): string {
  const base = JSON.stringify({ kind, title: title.toLowerCase(), affected: fingerprintAffected(affected) });
  return `visual-hive:${kind}:${crypto.createHash("sha256").update(base).digest("hex").slice(0, 16)}`;
}

function fingerprintAffected(affected: VisualHiveIssueCandidate["affected"]): VisualHiveIssueCandidate["affected"] {
  return affected.filter((surface) => {
    const resolutionScope = surface.contractId?.startsWith("testing-layer:") && Object.entries(surface).every(([key, value]) => key === "contractId" || value === undefined);
    return !resolutionScope;
  });
}

function safeFingerprintSegment(value: string): string {
  return sanitizeText(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function compareIssues(left: VisualHiveIssueCandidate, right: VisualHiveIssueCandidate): number {
  const severity = { critical: 0, high: 1, medium: 2, low: 3 };
  return severity[left.severity] - severity[right.severity] || left.issueKind.localeCompare(right.issueKind) || left.title.localeCompare(right.title);
}

function arrayOfObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function objectValue(value: unknown, key: string): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const child = (value as JsonObject)[key];
  return child && typeof child === "object" && !Array.isArray(child) ? (child as JsonObject) : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const child = (value as JsonObject)[key];
  return typeof child === "string" && child.trim() ? sanitizeText(child) : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => sanitizeText(entry)) : [];
}

function dedupe(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => sanitizeText(value.replaceAll("\\", "/"))))];
}

function resolve(rootDir: string, artifactPath: string): string {
  return path.isAbsolute(artifactPath) ? artifactPath : path.resolve(rootDir, artifactPath);
}

function sanitizeValue<T>(value: T): T {
  return JSON.parse(sanitizeText(JSON.stringify(value))) as T;
}
