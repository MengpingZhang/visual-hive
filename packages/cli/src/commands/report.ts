import { appendFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, readJson, writeJson, type MockProviderRunReport, type MutationReport, type ReadinessReport, type Report, type UxScoutResult } from "@visual-hive/core";

export interface ReportCommandOptions {
  config?: string;
  cwd?: string;
  format?: "markdown" | "json";
  githubStepSummary?: boolean;
}

export async function runReportCommand(options: ReportCommandOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const loaded = await loadConfig(options.config, cwd);
  const report = await readOptional<Report>(path.join(loaded.rootDir, ".visual-hive", "report.json"));
  const mutationReport = await readOptional<MutationReport>(path.join(loaded.rootDir, ".visual-hive", "mutation-report.json"));
  const readinessReport = await readOptional<ReadinessReport>(path.join(loaded.rootDir, ".visual-hive", "readiness.json"));
  const providerRunReport = await readOptional<MockProviderRunReport>(path.join(loaded.rootDir, ".visual-hive", "provider-results.json"));
  const uxScoutResult = await readOptional<UxScoutResult>(path.join(loaded.rootDir, ".visual-hive", "ux-scout-result.json"));
  const enrichedReport = report && uxScoutResult ? { ...report, uxScout: uxScoutResult } : report;
  if (enrichedReport) {
    await writeJson(path.join(loaded.rootDir, ".visual-hive", "report.json"), enrichedReport);
  }
  const output =
    options.format === "json"
      ? `${JSON.stringify({ report: enrichedReport, mutationReport, readinessReport, providerRunReport }, null, 2)}\n`
      : renderMarkdownReport(enrichedReport, mutationReport, readinessReport, providerRunReport);

  if (options.githubStepSummary) {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      await appendFile(summaryPath, output, "utf8");
    }
  }

  return output;
}

export function renderMarkdownReport(
  report?: Report,
  mutationReport?: MutationReport,
  readinessReport?: ReadinessReport,
  providerRunReport?: MockProviderRunReport
): string {
  const failed = report?.results.filter((result) => result.status === "failed") ?? [];
  const visualDiffs = report?.results.flatMap((result) => result.screenshotAssertions ?? []).filter((screenshot) => screenshot.status === "failed") ?? [];
  const lines = [
    "## Visual Hive Summary",
    "",
    `- Project: ${report?.project ?? mutationReport?.project ?? "unknown"}`,
    `- Repository: ${report?.repository?.repository ?? "unknown"}`,
    `- Branch: ${report?.repository?.branch ?? "unknown"}`,
    `- Commit: ${report?.repository?.commitSha ? report.repository.commitSha.slice(0, 12) : "unknown"}`,
    `- Run context: ${report?.repository?.provider ?? "unknown"}`,
    `- Deterministic status: ${report?.status ?? "not available"}`,
    `- Contracts: ${report?.results.length ?? 0}`,
    `- Failed contracts: ${failed.length}`,
    `- Created baselines: ${report?.summary?.createdBaselines ?? 0}`,
    `- Visual diffs: ${report?.summary?.visualDiffs ?? visualDiffs.length}`,
    `- Console errors: ${report?.summary?.consoleErrors ?? 0}`,
    `- Page errors: ${report?.summary?.pageErrors ?? 0}`,
    `- Flow steps: ${report?.summary?.flowStepsPassed ?? 0} passed, ${report?.summary?.flowStepsFailed ?? 0} failed`,
    `- Mutation score: ${mutationReport ? `${Math.round(mutationReport.score * 100)}% (${mutationReport.killed}/${mutationReport.total})` : "not available"}`,
    `- Readiness: ${readinessReport ? `${readinessReport.status} (${readinessReport.score}/100)` : "not available"}`,
    `- Providers: ${report?.providerResults?.map((provider) => `${provider.label}=${provider.status}`).join(", ") ?? "not available"}`,
    `- Provider adapter run: ${providerRunReport ? `${providerRunReport.summary.providerCount} providers, ${providerRunReport.summary.failedProviders} failed, external calls ${providerRunReport.providers.reduce((count, provider) => count + provider.normalized.externalCallsMade, 0)}` : "not available"}`,
    ""
  ];

  if (report?.uxScout) {
    lines.push(
      "### UX Scout Advisory",
      "",
      `- Status: ${report.uxScout.status}`,
      `- Advisory only: ${report.uxScout.advisoryOnly}`,
      `- Affected flows: ${report.uxScout.affectedFlows.join(", ") || "none"}`,
      `- Findings: ${report.uxScout.findings.length}`,
      ...report.uxScout.findings.map(
        (finding) =>
          `- [${finding.severity}] ${finding.category}: ${finding.title} — ${finding.recommendation}`
      ),
      ""
    );
  }

  if (failed.length > 0) {
    lines.push("### Failed Contracts", "");
    for (const result of failed) {
      lines.push(`- ${result.contractId} on ${result.targetId}: ${result.errors.join("; ") || "failed"}`);
    }
    lines.push("");
  }

  if (visualDiffs.length > 0) {
    lines.push("### Visual Diffs", "");
    for (const screenshot of visualDiffs) {
      lines.push(`- ${screenshot.name} (${screenshot.viewport} ${screenshot.route}): diffRatio=${screenshot.actualDiffPixelRatio}`);
    }
    lines.push("");
  }

  if ((report?.providerResults?.length ?? 0) > 0) {
    lines.push("### Provider Results", "");
    for (const provider of report?.providerResults ?? []) {
      lines.push(`- ${provider.label}: ${provider.status} (${provider.deterministicRole}) - ${provider.message}`);
      if (provider.externalUploadAllowed === false && provider.externalUploadBlockedReasons?.length) {
        lines.push(`  - External upload blocked: ${provider.externalUploadBlockedReasons.join(" ")}`);
      }
    }
    lines.push("");
  }

  if (providerRunReport) {
    lines.push("### Provider Adapter Run", "");
    for (const provider of providerRunReport.providers) {
      const upload = provider.result.upload;
      lines.push(
        `- ${provider.label}: result=${provider.result.status}, availability=${provider.availability}, upload=${upload?.status ?? provider.normalized.artifactSummary.uploadMode}, externalCalls=${provider.normalized.externalCallsMade}, staged=${upload?.stagedArtifacts ?? provider.artifacts.length}, uploaded=${upload?.uploadedArtifacts ?? provider.normalized.artifactSummary.uploadedArtifacts}`
      );
      if (upload?.providerUrl) lines.push(`  - Provider URL: ${upload.providerUrl}`);
      if (upload?.blockedReasons?.length) lines.push(`  - Blocked: ${upload.blockedReasons.join(" ")}`);
      if (upload?.command) lines.push(`  - Command: ${upload.command}`);
      if (upload?.stderr) lines.push(`  - Stderr: ${upload.stderr}`);
      if (upload?.stdout) lines.push(`  - Stdout: ${upload.stdout}`);
    }
    lines.push("");
  }

  if (readinessReport) {
    const blocking = readinessReport.gates.filter((gate) => gate.status === "blocked" || gate.status === "missing" || gate.status === "warning");
    lines.push("### Readiness Gate", "");
    lines.push(`- Status: ${readinessReport.status}`);
    lines.push(`- Score: ${readinessReport.score}/100`);
    lines.push(`- Blocked: ${readinessReport.summary.blocked}`);
    lines.push(`- Warnings: ${readinessReport.summary.warnings}`);
    lines.push(`- Missing evidence: ${readinessReport.summary.missing}`);
    for (const gate of blocking.slice(0, 6)) {
      lines.push(`- [${gate.status}] ${gate.title}: ${gate.message}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function readOptional<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJson<T>(filePath);
  } catch {
    return undefined;
  }
}
