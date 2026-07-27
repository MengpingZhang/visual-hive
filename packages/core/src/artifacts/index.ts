import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { VISUAL_HIVE_EVIDENCE_RESOURCES, type EvidenceResourceDefinition } from "../tools/evidenceResources.js";
import { sanitizeArtifactPathsForMarkdown, sanitizeText } from "../utils/sanitize.js";

export type ArtifactKind = "json" | "markdown" | "image" | "text" | "typescript" | "yaml" | "log" | "other";

export interface ArtifactIndexReport {
  schemaVersion: 1;
  project: string;
  generatedAt: string;
  root: string;
  summary: ArtifactIndexSummary;
  artifacts: ArtifactIndexEntry[];
  warnings: string[];
}

export interface ArtifactIndexSummary {
  artifactCount: number;
  totalBytes: number;
  json: number;
  markdown: number;
  image: number;
  text: number;
  typescript: number;
  yaml: number;
  log: number;
  other: number;
  previewed: number;
  redactedPreviews: number;
  truncatedPreviews: number;
}

export interface ArtifactIndexEntry {
  path: string;
  kind: ArtifactKind;
  contentType: string;
  bytes: number;
  safeToRender: boolean;
  evidenceResourceId?: string;
  evidenceResourceUri?: string;
  evidenceResourceTitle?: string;
  evidenceResourceDescription?: string;
  evidenceReadToolName?: string;
  schemaPath?: string;
  schemaId?: string;
  preview?: string;
  previewTruncated: boolean;
  previewRedacted: boolean;
  labels: string[];
}

export interface IndexArtifactsOptions {
  repoRoot: string;
  hiveRoot?: string;
  project?: string;
  now?: Date;
  maxArtifacts?: number;
  maxPreviewBytes?: number;
}

const DEFAULT_MAX_ARTIFACTS = 500;
const DEFAULT_MAX_PREVIEW_BYTES = 8192;
const GENERATED_ARTIFACT_INDEX = ".visual-hive/artifacts-index.json";
const SCHEMA_ID_BASE = "https://visual-hive.dev/schemas/";

export async function indexArtifacts(options: IndexArtifactsOptions): Promise<ArtifactIndexReport> {
  const repoRoot = path.resolve(options.repoRoot);
  const hiveRoot = path.resolve(options.hiveRoot ?? path.join(repoRoot, ".visual-hive"));
  if (!isInsideOrEqual(repoRoot, hiveRoot)) {
    throw new Error(`Refusing to index artifacts outside repository root: ${options.hiveRoot}`);
  }
  const maxArtifacts = options.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;
  const maxPreviewBytes = options.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW_BYTES;
  const warnings: string[] = [];
  const artifacts: ArtifactIndexEntry[] = [];
  let skippedHistoryDirectories = 0;

  await walk(
    hiveRoot,
    async (filePath) => {
      const repoRelativePath = toRepoRelativePath(repoRoot, filePath);
      if (isGeneratedArtifactIndex(repoRelativePath)) return;
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return;
      artifacts.push(await artifactEntry({ repoRoot, hiveRoot, filePath, bytes: fileStat.size, maxPreviewBytes }));
    },
    (dirPath) => {
      if (isBundlePayloadDirectory(hiveRoot, dirPath)) return true;
      if (!isRunHistoryDirectory(hiveRoot, dirPath)) return false;
      skippedHistoryDirectories += 1;
      return true;
    }
  );

  const sorted = artifacts.sort(compareArtifactEntries).slice(0, maxArtifacts);
  if (skippedHistoryDirectories > 0) {
    warnings.push(`Skipped ${skippedHistoryDirectories} run history director${skippedHistoryDirectories === 1 ? "y" : "ies"}; use history.json for summarized run history.`);
  }
  if (artifacts.length > maxArtifacts) {
    warnings.push(`Artifact listing reached maxArtifacts=${maxArtifacts}; some files may be omitted.`);
  }
  return {
    schemaVersion: 1,
    project: options.project ?? "unknown",
    generatedAt: (options.now ?? new Date()).toISOString(),
    root: toRepoRelativePath(repoRoot, hiveRoot),
    summary: summarize(sorted),
    artifacts: sorted,
    warnings
  };
}

function compareArtifactEntries(a: ArtifactIndexEntry, b: ArtifactIndexEntry): number {
  const rankDelta = artifactRank(a) - artifactRank(b);
  if (rankDelta !== 0) return rankDelta;
  return a.path.localeCompare(b.path);
}

function artifactRank(artifact: ArtifactIndexEntry): number {
  if (artifact.labels.includes("evidence-resource")) return 0;
  if (!artifact.labels.includes("history")) return 1;
  return 2;
}

export function artifactKind(filePath: string): ArtifactKind {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".log") return "log";
  if (ext === ".txt") return "text";
  return "other";
}

export function artifactContentType(kind: ArtifactKind, filePath: string): string {
  if (kind === "json") return "application/json; charset=utf-8";
  if (kind === "markdown" || kind === "text" || kind === "typescript" || kind === "yaml" || kind === "log") return "text/plain; charset=utf-8";
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function summarize(artifacts: ArtifactIndexEntry[]): ArtifactIndexSummary {
  const count = (kind: ArtifactKind) => artifacts.filter((artifact) => artifact.kind === kind).length;
  return {
    artifactCount: artifacts.length,
    totalBytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    json: count("json"),
    markdown: count("markdown"),
    image: count("image"),
    text: count("text"),
    typescript: count("typescript"),
    yaml: count("yaml"),
    log: count("log"),
    other: count("other"),
    previewed: artifacts.filter((artifact) => artifact.preview !== undefined).length,
    redactedPreviews: artifacts.filter((artifact) => artifact.previewRedacted).length,
    truncatedPreviews: artifacts.filter((artifact) => artifact.previewTruncated).length
  };
}

async function artifactEntry(input: {
  repoRoot: string;
  hiveRoot: string;
  filePath: string;
  bytes: number;
  maxPreviewBytes: number;
}): Promise<ArtifactIndexEntry> {
  const kind = artifactKind(input.filePath);
  const contentType = artifactContentType(kind, input.filePath);
  const repoRelativePath = toRepoRelativePath(input.repoRoot, input.filePath);
  const evidenceResource = evidenceResourceFor(repoRelativePath);
  const preview = await previewFor(input.repoRoot, input.filePath, kind, input.maxPreviewBytes);
  const labels = labelsFor(input.filePath, kind);
  if (evidenceResource) labels.push(evidenceResource.id, "evidence-resource");
  const schemaPath = schemaPathFor(input.filePath, kind);
  const entry: ArtifactIndexEntry = {
    path: repoRelativePath,
    kind,
    contentType,
    bytes: input.bytes,
    safeToRender: kind !== "other",
    previewTruncated: Boolean(preview?.truncated),
    previewRedacted: Boolean(preview?.redacted),
    labels: [...new Set(labels)].sort()
  };
  if (evidenceResource) {
    entry.evidenceResourceId = evidenceResource.id;
    entry.evidenceResourceUri = evidenceResource.uri;
    entry.evidenceResourceTitle = evidenceResource.title;
    entry.evidenceResourceDescription = evidenceResource.description;
    if (evidenceResource.readTool) entry.evidenceReadToolName = evidenceResource.readTool.name;
  }
  if (schemaPath) {
    entry.schemaPath = schemaPath;
    entry.schemaId = `${SCHEMA_ID_BASE}${path.basename(schemaPath)}`;
  }
  if (preview) entry.preview = preview.text;
  return entry;
}

function evidenceResourceFor(repoRelativePath: string): EvidenceResourceDefinition | undefined {
  const normalized = repoRelativePath.replaceAll("\\", "/").toLowerCase();
  return VISUAL_HIVE_EVIDENCE_RESOURCES.find((resource) => {
    const resourcePath = resource.relativePath.toLowerCase();
    return normalized === resourcePath || normalized.endsWith(`/${resourcePath}`);
  });
}

async function previewFor(
  repoRoot: string,
  filePath: string,
  kind: ArtifactKind,
  maxPreviewBytes: number
): Promise<{ text: string; truncated: boolean; redacted: boolean } | undefined> {
  if (kind === "image" || kind === "other") return undefined;
  const raw = await readFile(filePath);
  const slice = raw.subarray(0, maxPreviewBytes);
  const before = slice.toString("utf8");
  const text = sanitizeArtifactPathsForMarkdown(repoRoot, sanitizeText(before));
  return {
    text,
    truncated: raw.length > maxPreviewBytes,
    redacted: text !== before
  };
}

function labelsFor(filePath: string, kind: ArtifactKind): string[] {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const labels = new Set<string>();
  labels.add(kind);
  if (normalized.includes("/generated/") || normalized.endsWith(".generated.spec.ts")) labels.add("generated-spec");
  if (normalized.includes("/screenshots/")) labels.add("screenshot");
  if (normalized.includes("/snapshots/")) labels.add("baseline");
  if (normalized.includes("/history/")) labels.add("history");
  if (normalized.endsWith("history.json")) labels.add("history");
  if (normalized.endsWith("triage-prompt.md") || normalized.endsWith("repair-prompt.md") || normalized.endsWith("baseline-review.md")) {
    labels.add("prompt");
  }
  if (normalized.endsWith("baseline-review.md")) labels.add("baseline-review");
  if (normalized.endsWith("baselines.json")) labels.add("baseline-review");
  if (normalized.endsWith("issue.md")) labels.add("issue");
  if (normalized.endsWith("issues.json")) labels.add("issue-candidates");
  if (normalized.endsWith("issues.md")) labels.add("issue-candidates");
  if (normalized.endsWith("issue-queue.json")) labels.add("issue-queue");
  if (normalized.endsWith("issue-publish-plan.json")) labels.add("issue-publish-plan");
  if (normalized.endsWith("issue-publish-dry-run.json")) labels.add("issue-publish-dry-run");
  if (normalized.endsWith("issue-publish-result.json")) labels.add("issue-publish-result");
  if (normalized.endsWith("setup-issue.md")) labels.add("setup-issue");
  if (normalized.endsWith("setup-issue-candidate.json")) labels.add("setup-issue");
  if (normalized.endsWith("setup-issue-publish-plan.json")) labels.add("setup-issue-publish-plan");
  if (normalized.endsWith("setup-issue-publish-dry-run.json")) labels.add("setup-issue-publish-dry-run");
  if (normalized.endsWith("setup-issue-publish-result.json")) labels.add("setup-issue-publish-result");
  if (normalized.endsWith("pr-comment.md")) labels.add("pr-comment");
  if (/\/plan(?:\.[a-z0-9_-]+)?\.json$/.test(normalized)) labels.add("plan");
  if (normalized.endsWith("triage.json")) labels.add("triage-report");
  if (normalized.endsWith("risk.json")) labels.add("risk-register");
  if (normalized.endsWith("readiness.json")) labels.add("readiness-gate");
  if (normalized.endsWith("setup-progress.json")) labels.add("setup-progress");
  if (normalized.endsWith("setup-pr-plan.json")) labels.add("setup-pr-plan");
  if (normalized.endsWith("runbook.json")) labels.add("runbook");
  if (normalized.endsWith("plans.json")) labels.add("plan-lanes");
  if (normalized.endsWith("workflows.json")) labels.add("workflow-audit");
  if (normalized.endsWith("security.json")) labels.add("security-audit");
  if (normalized.endsWith("path-leak-scan.json")) labels.add("path-leak-scan");
  if (normalized.endsWith("costs.json")) labels.add("cost-audit");
  if (normalized.endsWith("control-plane-actions.json")) labels.add("control-plane-actions");
  if (normalized.endsWith("control-plane-snapshot.json")) labels.add("control-plane-snapshot");
  if (normalized.endsWith("report.json")) labels.add("report");
  if (normalized.endsWith("mutation-report.json")) labels.add("mutation");
  if (normalized.endsWith("flows.json")) labels.add("flow-audit");
  if (normalized.endsWith("provider-results.json")) labels.add("provider-results");
  if (normalized.endsWith("provider-decisions.json")) labels.add("provider-decisions");
  if (normalized.endsWith("provider-setup-plan.json")) labels.add("provider-setup-plan");
  if (normalized.endsWith("provider-handoff.json")) labels.add("provider-handoff");
  if (normalized.endsWith("/provider-upload/argos/manifest.json")) labels.add("provider-upload");
  if (normalized.endsWith("llm-decisions.json")) labels.add("llm-decisions");
  if (normalized.endsWith("connections-portfolio.json")) labels.add("connections-portfolio");
  if (normalized.endsWith("repo-map.json")) labels.add("repo-map");
  if (normalized.endsWith("repo-context.md")) labels.add("repo-context");
  if (normalized.endsWith("visual-graph.json")) labels.add("visual-graph");
  if (normalized.endsWith("visual-graph-summary.md")) labels.add("visual-graph-summary");
  if (normalized.endsWith("visual-graph-vocab.json")) labels.add("visual-graph-vocab");
  if (normalized.endsWith("visual-graph-unresolved.json")) labels.add("visual-graph-unresolved");
  if (normalized.endsWith("visual-impact.json")) labels.add("visual-graph-impact");
  if (normalized.endsWith("evidence-packet.json")) labels.add("evidence-packet");
  if (normalized.endsWith("evidence-summary.md")) labels.add("evidence-summary");
  if (normalized.endsWith("verdict.json")) labels.add("verdict");
  if (normalized.endsWith("verdict.md")) labels.add("verdict-summary");
  if (normalized.endsWith("testing-layers.json")) labels.add("testing-layers");
  if (normalized.endsWith("testing-layers.md")) labels.add("testing-layers-summary");
  if (normalized.endsWith("test-creation-plan.json")) labels.add("test-creation-plan");
  if (normalized.endsWith("test-creation-plan.md")) labels.add("test-creation-summary");
  if (normalized.endsWith("agent-packet.json")) labels.add("agent-packet");
  if (normalized.endsWith("agent-validation.json")) labels.add("agent-validation");
  if (normalized.endsWith("handoff-agent-packet.json")) labels.add("handoff-agent-packet");
  if (normalized.endsWith("provider-agent-packet.json")) labels.add("provider-agent-packet");
  if (normalized.endsWith("/agents/agent-run.json") || normalized.endsWith("/agent-run.json")) labels.add("agent-issue-run");
  if (normalized.endsWith("tool-registry.json")) labels.add("tool-registry");
  if (normalized.endsWith("tool-cards.md")) labels.add("tool-cards");
  if (normalized.endsWith("mcp-manifest.json")) labels.add("mcp-manifest");
  if (normalized.endsWith("context-ledger.json")) labels.add("context-ledger");
  if (normalized.endsWith("pipeline.json")) labels.add("pipeline-status");
  if (normalized.endsWith("schema-catalog.json")) labels.add("schema-catalog");
  if (normalized.endsWith("/handoff.json")) labels.add("handoff-packet");
  if (normalized.endsWith("hive-issue.md")) labels.add("hive-issue");
  if (normalized.endsWith("hive-bead-request.json")) labels.add("hive-bead-request");
  if (normalized.endsWith("hive-handoff-result.json")) labels.add("hive-handoff-result");
  if (normalized.endsWith("hive-handoff-validation.json")) labels.add("hive-handoff-validation");
  if (normalized.endsWith("/hive/hive-export.json")) labels.add("hive-export");
  if (normalized.endsWith("/hive/guarded-repair-preview.json")) labels.add("hive-guarded-repair-preview");
  if (normalized.endsWith("/hive/guarded-repair-preview.md")) labels.add("hive-guarded-repair-preview");
  if (normalized.endsWith("/hive/repair-request-envelope.json")) labels.add("hive-repair-request-envelope");
  if (normalized.endsWith("/hive/repair-request-envelope.md")) labels.add("hive-repair-request-envelope");
  if (normalized.endsWith("/hive/trusted-repair-consumer-summary.json")) labels.add("hive-trusted-repair-consumer-summary");
  if (normalized.endsWith("/hive/trusted-repair-consumer-summary.md")) labels.add("hive-trusted-repair-consumer-summary");
  if (normalized.endsWith("/hive/trusted-repair-workflow-dry-run.json")) labels.add("hive-trusted-repair-workflow-dry-run");
  if (normalized.endsWith("/hive/trusted-repair-workflow-dry-run.md")) labels.add("hive-trusted-repair-workflow-dry-run");
  if (normalized.endsWith("/hive/mode-comparison.json")) labels.add("hive-mode-comparison");
  if (normalized.endsWith("/hive/mode-comparison.md")) labels.add("hive-mode-comparison");
  if (normalized.includes("/hive/") && normalized.endsWith("/beads.json")) labels.add("hive-beads");
  if (normalized.includes("/hive/") && normalized.endsWith("/hive-beads.json")) labels.add("hive-beads");
  if (normalized.includes("/hive/") && normalized.endsWith("/hive-beads.md")) labels.add("hive-beads");
  if (normalized.includes("/hive/") && normalized.endsWith("/hive-import-manifest.json")) labels.add("hive-import-manifest");
  if (normalized.includes("/hive/") && normalized.endsWith("/hive-validation-summary.json")) labels.add("hive-validation");
  if (normalized.includes("/hive/") && normalized.endsWith("/hive-agent-work-orders.json")) labels.add("hive-agent-work-orders");
  if (normalized.includes("/hive/") && normalized.endsWith("/hive-setup-pack.json")) labels.add("hive-setup-pack");
  if (normalized.includes("/hive/") && normalized.endsWith("/hive-setup-pack.md")) labels.add("hive-setup-pack");
  if (normalized.includes("/hive/") && normalized.endsWith("/hive-integration-smoke.json")) labels.add("hive-integration-smoke");
  if (normalized.includes("/hive/") && normalized.endsWith("/hive-integration-smoke.md")) labels.add("hive-integration-smoke");
  if (normalized.includes("/hive/") && normalized.endsWith("/knowledge-facts.json")) labels.add("hive-knowledge");
  if (normalized.includes("/hive/") && normalized.endsWith("/knowledge-graph.json")) labels.add("hive-graph");
  if (normalized.includes("/hive/") && normalized.endsWith("/wiki-index.json")) labels.add("hive-wiki-index");
  if (normalized.includes("/hive/") && normalized.endsWith("/repair-work-orders.json")) labels.add("hive-repair");
  if (normalized.includes("/hive/") && normalized.endsWith("/hive-agent-policy.json")) labels.add("hive-agent-policy");
  if (normalized.endsWith("/hive/issue-context.md")) labels.add("hive-issue");
  if (normalized.includes("/hive/wiki/")) labels.add("hive-wiki");
  if (normalized.endsWith("/recommendations.json")) labels.add("setup-recommendations");
  if (normalized.endsWith("coverage-recommendations.json")) labels.add("coverage-recommendations");
  return [...labels].sort();
}

function schemaPathFor(filePath: string, kind: ArtifactKind): string | undefined {
  if (kind !== "json") return undefined;
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  if (normalized.endsWith("/provider-upload/argos/manifest.json")) return "schemas/visual-hive.provider-upload.schema.json";
  const fileName = path.basename(normalized);
  const mapping: Record<string, string> = {
    "plan.json": "visual-hive.plan.schema.json",
    "recommendations.json": "visual-hive.recommendations.schema.json",
    "coverage.json": "visual-hive.coverage.schema.json",
    "coverage-recommendations.json": "visual-hive.coverage-recommendations.schema.json",
    "contracts.json": "visual-hive.contracts.schema.json",
    "flows.json": "visual-hive.flows.schema.json",
    "targets.json": "visual-hive.targets.schema.json",
    "schedules.json": "visual-hive.schedules.schema.json",
    "workflows.json": "visual-hive.workflows.schema.json",
    "risk.json": "visual-hive.risk.schema.json",
    "readiness.json": "visual-hive.readiness.schema.json",
    "setup-progress.json": "visual-hive.setup-progress.schema.json",
    "setup-pr-plan.json": "visual-hive.setup-pr-plan.schema.json",
    "runbook.json": "visual-hive.runbook.schema.json",
    "control-plane-snapshot.json": "visual-hive.control-plane-snapshot.schema.json",
    "plans.json": "visual-hive.plans.schema.json",
    "security.json": "visual-hive.security.schema.json",
    "path-leak-scan.json": "visual-hive.path-leak-scan.schema.json",
    "costs.json": "visual-hive.costs.schema.json",
    "history.json": "visual-hive.history.schema.json",
    "triage.json": "visual-hive.triage.schema.json",
    "issues.json": "visual-hive.issues.schema.json",
    "issue-queue.json": "visual-hive.issue-queue.schema.json",
    "issue-publish-plan.json": "visual-hive.issue-publish-plan.schema.json",
    "issue-publish-dry-run.json": "visual-hive.issue-publish-dry-run.schema.json",
    "issue-publish-result.json": "visual-hive.issue-publish-result.schema.json",
    "setup-issue-candidate.json": "visual-hive.issues.schema.json",
    "setup-issue-publish-plan.json": "visual-hive.issue-publish-plan.schema.json",
    "setup-issue-publish-dry-run.json": "visual-hive.issue-publish-dry-run.schema.json",
    "setup-issue-publish-result.json": "visual-hive.issue-publish-result.schema.json",
    "llm-usage.json": "visual-hive.llm-usage.schema.json",
    "llm-decisions.json": "visual-hive.llm-decisions.schema.json",
    "connections.json": "visual-hive.connections.schema.json",
    "connections-portfolio.json": "visual-hive.connections-portfolio.schema.json",
    "repo-map.json": "visual-hive.repo-map.schema.json",
    "visual-graph.json": "visual-hive.visual-graph.schema.json",
    "visual-graph-vocab.json": "visual-hive.visual-graph-vocab.schema.json",
    "visual-graph-unresolved.json": "visual-hive.visual-graph-unresolved.schema.json",
    "visual-impact.json": "visual-hive.visual-impact.schema.json",
    "evidence-packet.json": "visual-hive.evidence-packet.schema.json",
    "verdict.json": "visual-hive.verdict.schema.json",
    "testing-layers.json": "visual-hive.testing-layers.schema.json",
    "test-creation-plan.json": "visual-hive.test-creation-plan.schema.json",
    "agent-packet.json": "visual-hive.agent-packet.schema.json",
    "agent-validation.json": "visual-hive.agent-validation.schema.json",
    "handoff-agent-packet.json": "visual-hive.agent-packet.schema.json",
    "provider-agent-packet.json": "visual-hive.agent-packet.schema.json",
    "agent-run.json": "visual-hive.agent-issue-run.schema.json",
    "tool-registry.json": "visual-hive.tool-registry.schema.json",
    "mcp-manifest.json": "visual-hive.mcp.schema.json",
    "context-ledger.json": "visual-hive.context-ledger.schema.json",
    "pipeline.json": "visual-hive.pipeline.schema.json",
    "schema-catalog.json": "visual-hive.schema-catalog.schema.json",
    "handoff.json": "visual-hive.handoff.schema.json",
    "ux-scout-context.json": "visual-hive.ux-scout-context.schema.json",
    "ux-scout-result.json": "visual-hive.ux-scout-result.schema.json",
    "hive-bead-request.json": "visual-hive.hive-bead-request.schema.json",
    "hive-handoff-result.json": "visual-hive.hive-handoff-result.schema.json",
    "hive-handoff-validation.json": "visual-hive.handoff-validation.schema.json",
    "hive-export.json": "visual-hive.hive-export.schema.json",
    "beads.json": "visual-hive.hive-beads.schema.json",
    "hive-beads.json": "visual-hive.hive-beads.schema.json",
    "hive-import-manifest.json": "visual-hive.hive-import-manifest.schema.json",
    "hive-validation-summary.json": "visual-hive.hive-validation-summary.schema.json",
    "hive-agent-work-orders.json": "visual-hive.hive-agent-work-orders.schema.json",
    "hive-setup-pack.json": "visual-hive.hive-setup-pack.schema.json",
    "hive-integration-smoke.json": "visual-hive.hive-integration-smoke.schema.json",
    "knowledge-facts.json": "visual-hive.hive-knowledge-facts.schema.json",
    "knowledge-graph.json": "visual-hive.hive-knowledge-graph.schema.json",
    "wiki-index.json": "visual-hive.hive-wiki-index.schema.json",
    "repair-work-orders.json": "visual-hive.hive-repair-work-orders.schema.json",
    "hive-agent-policy.json": "visual-hive.hive-agent-policy.schema.json",
    "guarded-repair-preview.json": "visual-hive.hive-guarded-repair-preview.schema.json",
    "repair-request-envelope.json": "visual-hive.hive-repair-request-envelope.schema.json",
    "trusted-repair-consumer-summary.json": "visual-hive.hive-trusted-repair-consumer-summary.schema.json",
    "trusted-repair-workflow-dry-run.json": "visual-hive.hive-trusted-repair-workflow-dry-run.schema.json",
    "mode-comparison.json": "visual-hive.hive-mode-comparison.schema.json",
    "provider-results.json": "visual-hive.provider-results.schema.json",
    "provider-decisions.json": "visual-hive.provider-decisions.schema.json",
    "provider-setup-plan.json": "visual-hive.provider-setup-plan.schema.json",
    "provider-handoff.json": "visual-hive.provider-handoff.schema.json",
    "artifacts-index.json": "visual-hive.artifacts.schema.json",
    "baseline-approvals.json": "visual-hive.baseline-approvals.schema.json",
    "baseline-rejections.json": "visual-hive.baseline-rejections.schema.json",
    "baselines.json": "visual-hive.baselines.schema.json",
    "mutation-report.json": "visual-hive.mutation-report.schema.json",
    "report.json": "visual-hive.report.schema.json"
  };
  const schemaFile = /^plan(?:\.[a-z0-9_-]+)?\.json$/.test(fileName) ? "visual-hive.plan.schema.json" : mapping[fileName];
  return schemaFile ? `schemas/${schemaFile}` : undefined;
}

async function walk(dir: string, visit: (filePath: string) => Promise<void>, shouldSkipDirectory?: (dirPath: string) => boolean): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory?.(child)) continue;
      await walk(child, visit, shouldSkipDirectory);
    } else if (entry.isFile()) {
      await visit(child);
    }
  }
}

function toRepoRelativePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isGeneratedArtifactIndex(repoRelativePath: string): boolean {
  return repoRelativePath.replaceAll("\\", "/") === GENERATED_ARTIFACT_INDEX;
}

function isRunHistoryDirectory(hiveRoot: string, dirPath: string): boolean {
  const relative = path.relative(hiveRoot, dirPath).replaceAll("\\", "/");
  const parts = relative.split("/").filter(Boolean);
  return parts.length >= 2 && parts[0] === "history";
}

function isBundlePayloadDirectory(hiveRoot: string, dirPath: string): boolean {
  const relative = path.relative(hiveRoot, dirPath).replaceAll(path.sep, "/");
  return /^bundles\/[^/]+\/files$/.test(relative);
}
