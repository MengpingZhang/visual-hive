import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  loadConfig,
  readJson,
  writeVisualHiveBundle,
  type HiveExportBundle,
  type VisualHiveBundleScanScope,
  type VisualHiveBundleSource,
  type VisualHiveIssuesReport,
  type WriteVisualHiveBundleResult
} from "@visual-hive/core";
import type { HiveImportManifest, HiveValidationSummary } from "./hive.js";

const execFileAsync = promisify(execFile);

export interface HiveBundleCommandOptions {
  config?: string;
  cwd?: string;
  hiveExport?: string;
  importManifest?: string;
  validationSummary?: string;
  issues?: string;
  outputDir?: string;
  trustedSource?: boolean;
  acmmRequest?: number;
  expiresInHours?: number;
  scanScope?: VisualHiveBundleScanScope;
  authoritativeForResolution?: boolean;
  evaluatedContracts?: string[];
  evaluatedFiles?: string[];
  testPlanVersion?: string;
  toolRegistryVersion?: string;
}

export async function runHiveBundleCommand(options: HiveBundleCommandOptions = {}): Promise<WriteVisualHiveBundleResult> {
  const loaded = await loadConfig(options.config, options.cwd ?? process.cwd());
  const rootDir = loaded.rootDir;
  const hiveExportPath = normalize(options.hiveExport ?? path.join(".visual-hive", "hive", "hive-export.json"));
  const importManifestPath = normalize(options.importManifest ?? path.join(".visual-hive", "hive", "hive-import-manifest.json"));
  const validationSummaryPath = normalize(options.validationSummary ?? path.join(".visual-hive", "hive", "hive-validation-summary.json"));
  const issuesPath = normalize(options.issues ?? path.join(".visual-hive", "issues.json"));
  const hiveExport = await readJson<HiveExportBundle>(path.resolve(rootDir, hiveExportPath));
  const importManifest = await readJson<HiveImportManifest>(path.resolve(rootDir, importManifestPath));
  const validation = await readJson<HiveValidationSummary>(path.resolve(rootDir, validationSummaryPath));
  const issues = await readJson<VisualHiveIssuesReport>(path.resolve(rootDir, issuesPath));
  if (importManifest.status !== "ready" || validation.status !== "passed") {
    throw new Error("Refusing to finalize a Visual Hive bundle whose import manifest or validation summary is not ready.");
  }

  const source = await sourceContext(rootDir, options.trustedSource ?? false);
  const artifacts = [
    hiveExportPath,
    importManifestPath,
    validationSummaryPath,
    issuesPath,
    ...Object.values(importManifest.sourceArtifacts),
    path.join(path.dirname(importManifestPath), "hive-setup-pack.json"),
    path.join(path.dirname(importManifestPath), "hive-setup-pack.md")
  ];
  const uxContextPath = path.join(".visual-hive", "ux-scout-context.json");
  if (await access(path.resolve(rootDir, uxContextPath)).then(() => true).catch(() => false)) artifacts.push(uxContextPath);
  return writeVisualHiveBundle({
    rootDir,
    project: hiveExport.project,
    mode: hiveExport.mode,
    verdict: hiveExport.status,
    acmmRequest: options.acmmRequest ?? hiveExport.acmmLevel,
    artifacts,
    source,
    scan: {
      scope: options.scanScope ?? "partial",
      authoritativeForResolution: options.authoritativeForResolution ?? false,
      evaluatedContracts: options.evaluatedContracts ?? [],
      evaluatedFiles: options.evaluatedFiles ?? [],
      testPlanVersion: options.testPlanVersion ?? "visual-hive.test-plan.v1",
      toolRegistryVersion: options.toolRegistryVersion ?? "visual-hive.tool-registry.v1"
    },
    issues: issues.issues,
    issuesArtifact: issuesPath,
    producerVersion: process.env.VISUAL_HIVE_VERSION ?? process.env.npm_package_version ?? "0.2.2-dev",
    producerGitCommit: process.env.VISUAL_HIVE_GIT_COMMIT ?? process.env.VISUAL_HIVE_BUILD_SHA ?? "unavailable",
    externalCallsMade: hiveExport.externalCallsMade,
    expiresInHours: options.expiresInHours,
    outputDir: options.outputDir
  });
}

export function formatHiveBundle(result: WriteVisualHiveBundleResult, format: "markdown" | "json" = "markdown"): string {
  if (format === "json") return JSON.stringify(result.manifest, null, 2);
  return [
    `Wrote ${result.manifestPath}`,
    "",
    `# Visual Hive Atomic Bundle: ${result.manifest.project}`,
    "",
    `- Bundle ID: ${result.manifest.bundleId}`,
    `- Source: ${result.manifest.source.repository}@${result.manifest.source.commitSha}`,
    `- Trusted source: ${result.manifest.source.trusted}`,
    `- Files: ${result.manifest.files.length}`,
    `- SHA-256: ${result.manifest.overallDigest}`,
    `- Expires: ${result.manifest.expiresAt}`
  ].join("\n");
}

async function sourceContext(rootDir: string, trustedSource: boolean): Promise<VisualHiveBundleSource> {
  const repository = process.env.GITHUB_REPOSITORY ?? parseRepository(await git(rootDir, ["config", "--get", "remote.origin.url"]));
  const event = process.env.GITHUB_EVENT_NAME ?? "local";
  if (event === "pull_request" && trustedSource) throw new Error("Pull-request workflow artifacts cannot be marked as a trusted import source.");
  return {
    repository,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    ref: process.env.GITHUB_REF ?? (await git(rootDir, ["symbolic-ref", "--short", "HEAD"])),
    commitSha: process.env.GITHUB_SHA ?? (await git(rootDir, ["rev-parse", "HEAD"])),
    event,
    workflowName: process.env.GITHUB_WORKFLOW,
    workflowRunId: process.env.GITHUB_RUN_ID,
    workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    workflowArtifactId: process.env.VISUAL_HIVE_WORKFLOW_ARTIFACT_ID,
    conclusion: process.env.VISUAL_HIVE_SOURCE_CONCLUSION ?? (process.env.GITHUB_ACTIONS === "true" ? "success" : "local"),
    trusted: trustedSource
  };
}

async function git(rootDir: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", rootDir, ...args], { timeout: 10_000, windowsHide: true });
    return result.stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function parseRepository(remote: string): string {
  const normalized = remote.trim().replace(/\.git$/, "");
  const match = normalized.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  return (match?.[1] ?? normalized) || "unknown";
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}
