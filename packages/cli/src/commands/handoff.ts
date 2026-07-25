import path from "node:path";
import {
  buildUxScoutContext,
  loadConfig,
  handoffModeFromHiveMode,
  readEvidencePacket,
  readJson,
  writeJson,
  validateHandoffArtifacts,
  writeHandoffArtifacts,
  type HandoffArtifacts,
  type HandoffValidationReport,
  type HandoffMode,
  type HandoffPacket,
  type HiveBeadDryRunRequest,
  type HiveHandoffResult,
  type FlowAuditReport
} from "@visual-hive/core";

export interface HandoffCommandOptions {
  config?: string;
  cwd?: string;
  evidence?: string;
  mode?: HandoffMode;
  label?: string[];
  agent?: string;
}

export interface HandoffValidateCommandOptions {
  config?: string;
  cwd?: string;
  evidence?: string;
  handoff?: string;
  issue?: string;
  beadRequest?: string;
  result?: string;
  output?: string;
  format?: "markdown" | "json";
}

export interface HandoffValidateCommandResult {
  report: HandoffValidationReport;
  reportPath: string;
  exitCode: number;
}

export interface HandoffCommandResult extends HandoffArtifacts {
  handoffPath: string;
  issuePath: string;
  beadRequestPath: string;
  resultPath: string;
}

export async function runHandoffCommand(options: HandoffCommandOptions = {}): Promise<HandoffCommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const loaded = await loadConfig(options.config, cwd);
  const hiveConfig = loaded.config.integrations.hive;
  const evidencePath = path.resolve(loaded.rootDir, options.evidence ?? path.join(".visual-hive", "evidence-packet.json"));
  let evidencePacket;
  try {
    evidencePacket = await readEvidencePacket(evidencePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Missing or invalid Evidence Packet at ${evidencePath}. Run "visual-hive evidence" before "visual-hive handoff --dry-run". Details: ${message}`);
  }
  const mode = options.mode ?? handoffModeFromHiveMode(hiveConfig.mode) ?? "dry_run";
  const flows = await readOptionalJson<FlowAuditReport>(path.resolve(loaded.rootDir, ".visual-hive/flows.json"), evidencePacket);
  const uxScoutContext = buildUxScoutContext({ flows, evidence: evidencePacket });
  const result = await writeHandoffArtifacts({
    rootDir: loaded.rootDir,
    evidencePacket,
    uxScoutContext,
    evidencePacketPath: path.relative(loaded.rootDir, evidencePath).replaceAll(path.sep, "/"),
    mode,
    labels: options.label?.length ? options.label : hiveConfig.labels,
    agent: options.agent ?? hiveConfig.beadApi.agent,
    hiveIntegration: {
      enabled: hiveConfig.enabled,
      mode: handoffModeFromHiveMode(hiveConfig.mode),
      beadApi: {
        url: hiveConfig.beadApi.url,
        tokenEnv: hiveConfig.beadApi.tokenEnv,
        agent: hiveConfig.beadApi.agent,
        tokenPresent: Boolean(process.env[hiveConfig.beadApi.tokenEnv])
      }
    }
  });
  await writeJson(path.join(loaded.rootDir, ".visual-hive/ux-scout-context.json"), uxScoutContext);
  return result;
}

async function readOptionalJson<T>(filePath: string, evidence: { project: string }): Promise<FlowAuditReport> {
  try {
    return await readJson<T>(filePath) as FlowAuditReport;
  } catch {
    return {
      schemaVersion: 1,
      project: evidence.project,
      generatedAt: new Date().toISOString(),
      summary: {
        contractCount: 0,
        flowContractCount: 0,
        selectedFlowContracts: 0,
        flowStepCount: 0,
        navigationSteps: 0,
        interactionSteps: 0,
        assertionSteps: 0,
        failedFlowSteps: 0,
        contractsWithoutFlow: 0,
        criticalContractsWithoutFlow: 0,
        highSeverityFlowGaps: 0
      },
      flows: [],
      recommendations: []
    };
  }
}

export function formatHandoffResult(result: HandoffCommandResult, format: "markdown" | "json" = "markdown"): string {
  if (format === "json") {
    return JSON.stringify(
      {
        handoff: result.handoff as HandoffPacket,
        beadRequest: result.beadRequest as HiveBeadDryRunRequest,
        result: result.result as HiveHandoffResult
      },
      null,
      2
    );
  }
  return [
    `Wrote ${result.handoffPath}`,
    `Wrote ${result.issuePath}`,
    `Wrote ${result.beadRequestPath}`,
    `Wrote ${result.resultPath}`,
    "",
    `# Hive Handoff Dry Run: ${result.handoff.project}`,
    "",
    `- Status: ${result.handoff.status}`,
    `- Mode: ${result.handoff.mode}`,
    `- Visual Hive verdict: ${result.handoff.verdict.visualHiveVerdict}`,
    `- Work items: ${result.handoff.workItems.length}`,
    `- External calls made: ${result.handoff.externalCallsMade}`,
    `- Labels: ${result.handoff.labels.join(", ")}`,
    `- Trusted workflow required: ${result.handoff.githubIssue.trustedWorkflowRequired}`,
    ...(result.handoff.blockedReasons.length ? [`- Blocked reasons: ${result.handoff.blockedReasons.join("; ")}`] : [])
  ].join("\n");
}

export async function runHandoffValidateCommand(options: HandoffValidateCommandOptions = {}): Promise<HandoffValidateCommandResult> {
  const loaded = await loadConfig(options.config, options.cwd ?? process.cwd());
  const result = await validateHandoffArtifacts({
    rootDir: loaded.rootDir,
    evidencePacketPath: options.evidence,
    handoffPath: options.handoff,
    issuePath: options.issue,
    beadRequestPath: options.beadRequest,
    resultPath: options.result,
    outputPath: options.output
  });
  return {
    ...result,
    exitCode: result.report.status === "blocked" ? 1 : 0
  };
}

export function formatHandoffValidation(result: HandoffValidateCommandResult, format: "markdown" | "json" = "markdown"): string {
  if (format === "json") return JSON.stringify(result.report, null, 2);
  return [
    `Wrote ${result.reportPath}`,
    "",
    `# Hive Handoff Validation: ${result.report.project}`,
    "",
    `- Status: ${result.report.status}`,
    `- Checks passed: ${result.report.summary.checksPassed}`,
    `- Warnings: ${result.report.summary.warnings}`,
    `- Blocked checks: ${result.report.summary.blocked}`,
    `- External calls made: ${result.report.summary.externalCallsMade}`,
    `- Work items: ${result.report.summary.workItems}`,
    `- Recommended Hive mode: ${result.report.hiveReadiness.recommendedMode} (${result.report.hiveReadiness.recommendedStatus})`,
    `- Hive mode readiness: ${result.report.hiveReadiness.readyModes.length} ready / ${result.report.hiveReadiness.trustedOnlyModes.length} trusted-only / ${result.report.hiveReadiness.blockedModes.length} blocked`,
    `- Full automation blocked: ${result.report.hiveReadiness.fullAutomationBlocked}`,
    `- Guarded repair restricted: ${result.report.hiveReadiness.guardedRepairTrustedOnlyOrBlocked}`,
    "",
    "## Checks",
    ...result.report.checks.map((check) => `- [${check.status}] ${check.id}: ${check.message}`),
    ...(result.report.blockedReasons.length ? ["", "## Blocked Reasons", ...result.report.blockedReasons.map((reason) => `- ${reason}`)] : []),
    ...(result.report.warnings.length ? ["", "## Warnings", ...result.report.warnings.map((warning) => `- ${warning}`)] : [])
  ].join("\n");
}
