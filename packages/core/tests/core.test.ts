import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { VisualHiveConfigSchema, type VisualHiveConfig } from "../src/config/schema.js";
import { auditContracts } from "../src/contracts/audit.js";
import { analyzeCoverage } from "../src/coverage/analyze.js";
import { applyCoverageImprovementRecommendation, buildCoverageImprovementReport } from "../src/coverage/improve.js";
import { auditFlows } from "../src/flows/audit.js";
import { auditTargets } from "../src/targets/audit.js";
import { resolveTargetUrl } from "../src/targets/resolve.js";
import { auditSchedules } from "../src/schedules/audit.js";
import { createPlan } from "../src/planner/createPlan.js";
import { buildPlanLaneSummary } from "../src/planner/laneSummary.js";
import { buildMutationReport, calculateMutationScore } from "../src/mutations/score.js";
import { loadConfig, parseConfigText } from "../src/config/load.js";
import { MUTATION_OPERATOR_METADATA, selectContractsForMutation } from "../src/mutations/operators.js";
import { approveBaseline, listBaselines, rejectBaseline, writeBaselineReview } from "../src/baselines/manage.js";
import { listProviderAdapters, PROVIDER_ADAPTER_OPERATION_SEQUENCE } from "../src/providers/adapter.js";
import { readProviderDecisionLog, recordProviderDecision } from "../src/providers/decisions.js";
import { inspectProviders, normalizeProviderResults } from "../src/providers/inspect.js";
import { runMockProviderAdapters } from "../src/providers/mock.js";
import { buildProviderSetupPlan } from "../src/providers/setupPlan.js";
import { buildProviderHandoffManifest } from "../src/providers/handoff.js";
import { uploadProviderArtifacts } from "../src/providers/upload.js";
import { createRunHistoryEntry, createRunHistoryReport, recordRunHistory } from "../src/history/record.js";
import { buildEvidencePacket, buildReportVerdict, writeEvidencePacket } from "../src/evidence/build.js";
import { buildVerdictReport, writeVerdictReport } from "../src/verdict/build.js";
import { buildTestingLayerReport, writeTestingLayerReport } from "../src/layers/build.js";
import { buildTestCreationPlan, writeTestCreationPlan } from "../src/testCreation/build.js";
import { buildHandoffArtifacts, writeHandoffArtifacts } from "../src/handoff/build.js";
import { validateHandoffArtifacts } from "../src/handoff/validate.js";
import {
  writeHiveExportArtifacts,
  writeHiveGuardedRepairPreview,
  writeHiveRepairRequestEnvelope,
  writeHiveTrustedRepairConsumerSummary,
  writeHiveTrustedRepairWorkflowDryRun
} from "../src/hive/build.js";
import { buildAgentPacket, writeAgentPacket } from "../src/agent/build.js";
import { writeAgentIssueRun } from "../src/agent/issueRunner.js";
import { writeAgentWritePreview } from "../src/agent/writePreview.js";
import { validateAgentArtifacts } from "../src/agent/validate.js";
import { buildIssuesReport, writeIssuesArtifacts } from "../src/issues/build.js";
import { writeIssuePublishArtifacts } from "../src/issues/publish.js";
import { buildToolRegistry, writeToolRegistry } from "../src/tools/build.js";
import { VISUAL_HIVE_EVIDENCE_RESOURCES } from "../src/tools/evidenceResources.js";
import { buildContextLedger, writeContextLedger } from "../src/context/build.js";
import { verifySchemaCatalog } from "../src/schemas/catalog.js";
import { analyzeRepository, writeRepoMap } from "../src/repo/analyze.js";
import { analyzeVisualImpact, readVisualGraph, searchVisualGraph, writeVisualGraphArtifacts } from "../src/graph/build.js";
import { detectVisualGraphExtractors, VISUAL_HIVE_GRAPH_EXTRACTORS } from "../src/graph/extractors.js";
import { analyzeRisk } from "../src/risk/analyze.js";
import { analyzeReadiness } from "../src/readiness/analyze.js";
import { analyzeSecurity, npmAuditSummaryFromJson } from "../src/security/audit.js";
import { scanIssueFacingPaths } from "../src/security/pathScan.js";
import { analyzeCosts } from "../src/costs/analyze.js";
import { auditWorkflows } from "../src/github/workflowAudit.js";
import { githubWorkflowTemplates } from "../src/github/workflowTemplates.js";
import { readLLMDecisionLog, recordLLMDecision } from "../src/llm/decisions.js";
import { buildLLMUsageReport, KNOWN_LLM_PROMPT_ARTIFACTS } from "../src/llm/usage.js";
import { buildTriageReport } from "../src/reports/triageReport.js";
import { indexArtifacts } from "../src/artifacts/index.js";
import { addConnection, listConnections, removeConnection } from "../src/connections/manage.js";
import { buildSetupDocsMarkdown } from "../src/setup/docs.js";
import { buildSetupPullRequestPlan } from "../src/setup/prPlan.js";
import { buildSetupProgress } from "../src/setup/progress.js";
import { recommendSetup } from "../src/setup/recommend.js";
import { writeJson } from "../src/utils/files.js";
import { sanitizeArtifactPathForIssue, sanitizeArtifactPathsForMarkdown } from "../src/utils/sanitize.js";
import type { MutationReport, Report } from "../src/reports/types.js";

const sourceRepoRoot = process.cwd().endsWith(path.join("packages", "core")) ? path.resolve(process.cwd(), "..", "..") : process.cwd();

const tempDirs: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sampleRepository = {
  provider: "local" as const,
  repository: "visual-hive/test",
  branch: "main",
  commitSha: "abcdef1234567890"
};

async function expectMatchesSchema(schemaName: string, value: unknown): Promise<void> {
  const schemasDir = path.join(repoRoot, "schemas");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(await readFile(path.join(schemasDir, schemaName), "utf8")) as Record<string, unknown>;
  const referencedSchemaNames = new Set<string>();
  const collectReferences = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(collectReferences);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (
        key === "$ref" &&
        typeof child === "string" &&
        !child.startsWith("#/")
      ) {
        referencedSchemaNames.add(
          child.startsWith("https://visual-hive.dev/schemas/")
            ? child.slice("https://visual-hive.dev/schemas/".length)
            : child
        );
      } else {
        collectReferences(child);
      }
    }
  };
  collectReferences(schema);
  for (const referencedSchemaName of referencedSchemaNames) {
    ajv.addSchema(
      JSON.parse(await readFile(path.join(schemasDir, referencedSchemaName), "utf8")) as Record<string, unknown>
    );
  }
  const validate = ajv.compile(schema);
  const valid = validate(value);
  if (!valid) {
    throw new Error(`${schemaName} validation failed: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
  }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function sampleConfig(): VisualHiveConfig {
  return VisualHiveConfigSchema.parse({
    project: {
      name: "sample",
      type: "react-vite",
      defaultBranch: "main"
    },
    targets: {
      safe: {
        kind: "url",
        url: "https://safe.example.com",
        prSafe: true,
        cost: "cheap"
      },
      unsafe: {
        kind: "url",
        url: "https://unsafe.example.com",
        prSafe: false,
        cost: "expensive"
      }
    },
    contracts: [
      {
        id: "safe-contract",
        description: "safe",
        target: "safe",
        severity: "high",
        runOn: { pullRequest: true, schedule: true },
        selectors: { mustExist: ["main"] },
        screenshots: [{ name: "home", route: "/", viewport: "desktop" }]
      },
      {
        id: "unsafe-contract",
        description: "unsafe",
        target: "unsafe",
        severity: "critical",
        runOn: { pullRequest: true, schedule: true },
        selectors: { mustExist: ["main"] }
      },
      {
        id: "changed-contract",
        description: "changed",
        target: "safe",
        severity: "medium",
        runOn: { pullRequest: false, schedule: false },
        selectors: { mustExist: ["main"] }
      }
    ],
    viewports: {
      desktop: { width: 1440, height: 900 }
    },
    selection: {
      ignoreChangedFiles: [
        {
          pattern: "docs/**",
          reason: "documentation-only"
        },
        {
          pattern: "**/*.md",
          reason: "markdown-only"
        },
        {
          pattern: "*.md",
          reason: "root markdown-only"
        }
      ],
      changedFiles: [
        {
          pattern: "src/**",
          contracts: ["changed-contract"],
          risk: "medium"
        }
      ]
    },
    mutation: {
      enabled: true,
      runOn: { schedule: true },
      minScore: 0.7,
      operators: ["hide-critical-button", "force-login-on-demo"]
    },
    ai: {
      enabled: false,
      provider: "none",
      neverSoleOracle: true,
      createIssuePrompt: true,
      maxDailyRuns: 5
    },
    github: {
      enabled: true,
      issueLabels: ["visual-hive"],
      commentMarker: "<!-- visual-hive-report -->"
    }
  });
}

describe("config validation", () => {
  it("accepts a valid config", () => {
    expect(sampleConfig().project.name).toBe("sample");
    expect(sampleConfig().project.setupProfile).toBe("free-local");
  });

  it("applies visual config defaults", () => {
    expect(sampleConfig().visual).toMatchObject({
      maxDiffPixelRatio: 0.01,
      updateSnapshots: false,
      failOnMissingBaselineInCI: true,
      baselinePlatform: "shared",
      snapshotDir: ".visual-hive/snapshots",
      artifactDir: ".visual-hive/artifacts"
    });
  });

  it("applies ignored changed-file defaults and validation", () => {
    const config = VisualHiveConfigSchema.parse({
      ...sampleConfig(),
      selection: {
        ignoreChangedFiles: [{ pattern: "docs/**" }]
      }
    });
    expect(config.selection.ignoreChangedFiles[0]).toEqual({
      pattern: "docs/**",
      reason: "changed file is ignored for visual planning"
    });
    expect(() =>
      VisualHiveConfigSchema.parse({
        ...sampleConfig(),
        selection: {
          ignoreChangedFiles: [{ pattern: "" }]
        }
      })
    ).toThrow();
  });

  it("validates contract flow steps", () => {
    const config = VisualHiveConfigSchema.parse({
      ...sampleConfig(),
      contracts: [
        {
          id: "flow-contract",
          description: "Flow contract",
          target: "safe",
          runOn: { pullRequest: true },
          steps: [
            { action: "goto", route: "/" },
            { action: "click", selector: "[data-testid='critical-action-button']" },
            { action: "assertText", selector: ".data-status", text: "Demo metrics loaded" }
          ]
        }
      ]
    });

    expect(config.contracts[0]?.steps.map((step) => step.action)).toEqual(["goto", "click", "assertText"]);
    expect(config.contracts[0]?.steps[0]?.timeoutMs).toBe(5000);
    expect(() =>
      VisualHiveConfigSchema.parse({
        ...sampleConfig(),
        contracts: [{ id: "broken-flow", description: "Broken", target: "safe", steps: [{ action: "click" }] }]
      })
    ).toThrow(/click steps require selector/);
  });

  it("applies AI governance defaults", () => {
    expect(sampleConfig().ai).toMatchObject({
      enabled: false,
      provider: "none",
      model: "offline-heuristics",
      neverSoleOracle: true,
      maxDailyRuns: 5,
      maxPromptTokens: 50000,
      maxEstimatedCostUsd: 0
    });
  });

  it("applies provider cost policy defaults", () => {
    expect(sampleConfig().costPolicy).toMatchObject({
      maxExternalScreenshotsPerRun: 0,
      maxMonthlyExternalScreenshots: 5000,
      externalUpload: {
        pullRequest: false,
        schedule: true,
        manual: true,
        canary: false,
        mutation: false,
        full: true,
        onFailureOnly: true,
        criticalContractsOnly: true
      }
    });
  });

  it("applies disabled Hive integration advisory defaults", () => {
    expect(sampleConfig().integrations.hive).toMatchObject({
      enabled: false,
      mode: "advisory",
      acmmLevel: 3,
      defaultActor: "quality",
      labels: ["visual-hive", "hive/quality", "ai-ready"],
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
      },
      beadApi: {
        tokenEnv: "HIVE_DASHBOARD_TOKEN",
        agent: "quality"
      }
    });
  });

  it("applies provider defaults and inspects credential names only", () => {
    const config = VisualHiveConfigSchema.parse({
      ...sampleConfig(),
      providers: {
        argos: { enabled: true },
        percy: { enabled: true, mode: "mock" }
      }
    });
    expect(config.providers.playwright.enabled).toBe(true);
    expect(config.providers.argos.requiredEnv).toEqual(["ARGOS_TOKEN"]);

    const inspected = inspectProviders(config, {});
    expect(inspected.find((provider) => provider.id === "playwright")?.availability).toBe("available");
    expect(inspected.find((provider) => provider.id === "argos")?.missingEnv).toEqual(["ARGOS_TOKEN"]);
    expect(inspected.find((provider) => provider.id === "argos")?.message).not.toContain("undefined");
    expect(inspected.find((provider) => provider.id === "percy")?.availability).toBe("mock");

    const normalized = normalizeProviderResults(config, { deterministicStatus: "passed", artifactCount: 3 }, {});
    expect(normalized.find((provider) => provider.providerId === "playwright")).toMatchObject({
      status: "passed",
      deterministicRole: "oracle",
      artifactCount: 3
    });
    expect(normalized.find((provider) => provider.providerId === "argos")).toMatchObject({
      status: "missing_credentials",
      missingEnv: ["ARGOS_TOKEN"]
    });
    expect(normalized.find((provider) => provider.providerId === "percy")?.status).toBe("mock");
  });

  it("validates Argos upload config defaults and safe extra file paths", () => {
    const config = VisualHiveConfigSchema.parse({
      ...sampleConfig(),
      providers: {
        argos: {
          enabled: true,
          upload: {
            buildName: "nightly visual review",
            includeTextArtifacts: true,
            extraFiles: [".visual-hive/report.json", "docs/visual-notes.md"]
          }
        }
      }
    });

    expect(config.providers.argos.upload).toMatchObject({
      buildName: "nightly visual review",
      includeActualScreenshots: true,
      includeDiffScreenshots: true,
      includeTextArtifacts: true,
      extraFiles: [".visual-hive/report.json", "docs/visual-notes.md"]
    });
    expect(() =>
      VisualHiveConfigSchema.parse({
        ...sampleConfig(),
        providers: {
          argos: {
            enabled: true,
            upload: {
              extraFiles: ["../secrets.env"]
            }
          }
        }
      })
    ).toThrow(/repo-relative/);
  });

  it("blocks external provider upload by default cost policy", () => {
    const config = VisualHiveConfigSchema.parse({
      ...sampleConfig(),
      providers: {
        argos: { enabled: true }
      }
    });

    const inspected = inspectProviders(config, { ARGOS_TOKEN: "secret-token" }, { mode: "pr", deterministicStatus: "passed", artifactCount: 3 });
    const argos = inspected.find((provider) => provider.id === "argos");
    expect(argos?.availability).toBe("policy_blocked");
    expect(argos?.costPolicy.externalUploadAllowed).toBe(false);
    expect(argos?.costPolicy.blockedReasons.join(" ")).toContain("pullRequest=false");
    expect(argos?.costPolicy.blockedReasons.join(" ")).toContain("onFailureOnly=true");
    expect(argos?.costPolicy.blockedReasons.join(" ")).toContain("maxExternalScreenshotsPerRun 0");

    const normalized = normalizeProviderResults(config, { deterministicStatus: "passed", artifactCount: 3, mode: "pr" }, { ARGOS_TOKEN: "secret-token" });
    expect(normalized.find((provider) => provider.providerId === "argos")).toMatchObject({
      status: "skipped",
      externalUploadAllowed: false,
      estimatedExternalScreenshots: 3
    });
  });

  it("builds a no-network provider setup plan with required authorization and no secret values", () => {
    const config = VisualHiveConfigSchema.parse({
      ...sampleConfig(),
      providers: {
        argos: { enabled: true, projectId: "visual-hive/demo" }
      }
    });

    const plan = buildProviderSetupPlan(config, {
      providerId: "argos",
      env: { ARGOS_TOKEN: "super-secret-token-value" },
      generatedAt: "2026-06-15T00:00:00.000Z"
    });

    expect(plan).toMatchObject({
      schemaVersion: 1,
      project: "sample",
      providerId: "argos",
      label: "Argos",
      recommendation: "blocked",
      authorizationRequired: true,
      externalCallsMade: 0,
      readiness: {
        enabled: true,
        mode: "external",
        missingEnv: [],
        projectIdConfigured: true,
        externalUploadAllowed: false
      }
    });
    expect(plan.readiness.externalUploadBlockedReasons.join(" ")).toContain("onFailureOnly=true");
    expect(plan.configChanges.join(" ")).toContain("costPolicy.externalUpload.pullRequest=false");
    expect(plan.workflowSteps.join(" ")).toContain("trusted environments");
    expect(plan.safetyChecks.join(" ")).toContain("verdict authority");
    expect(plan.validationCommands).toContain("visual-hive providers list --mock-results");
    expect(JSON.stringify(plan)).not.toContain("super-secret-token-value");
  });

  it("keeps disabled providers advisory in setup plans", () => {
    const plan = buildProviderSetupPlan(sampleConfig(), {
      providerId: "percy",
      env: {},
      generatedAt: "2026-06-15T00:00:00.000Z"
    });

    expect(plan.recommendation).toBe("keep_disabled");
    expect(plan.authorizationRequired).toBe(true);
    expect(plan.readiness.missingEnv).toEqual(["PERCY_TOKEN"]);
    expect(plan.configChanges.join(" ")).toContain("enabled=true only after approving");
    expect(plan.warnings.join(" ")).toContain("Provider is currently disabled");
    expect(plan.externalCallsMade).toBe(0);
  });

  it("runs mock provider adapter operations without leaking credential values", () => {
    const config = VisualHiveConfigSchema.parse({
      ...sampleConfig(),
      costPolicy: {
        maxExternalScreenshotsPerRun: 25,
        maxMonthlyExternalScreenshots: 5000,
        externalUpload: {
          pullRequest: false,
          schedule: true,
          manual: true,
          canary: false,
          mutation: false,
          full: true,
          onFailureOnly: false,
          criticalContractsOnly: false
        }
      },
      providers: {
        argos: { enabled: true, projectId: "visual-hive/demo" },
        percy: { enabled: true },
        storybook: { enabled: true, mode: "mock" },
        "github-checks": { enabled: true, mode: "mock" }
      }
    });

    const report = runMockProviderAdapters(
      config,
      {
        deterministicStatus: "passed",
        artifactCount: 2,
        artifactPaths: [".visual-hive/report.json", ".visual-hive/artifacts/screenshots/dashboard.png"],
        generatedAt: "2026-06-15T00:00:00.000Z",
        mode: "manual"
      },
      { ARGOS_TOKEN: "super-secret-token-value" }
    );

    expect(report.schemaVersion).toBe(1);
    expect(report.summary.mockProviders).toBe(2);
    expect(report.summary.externalDeferredProviders).toBe(1);
    expect(report.summary.missingCredentialProviders).toBe(1);
    expect(report.providers.find((provider) => provider.providerId === "storybook")?.operations.map((operation) => operation.operation)).toEqual([
      "availability",
      "upload_artifact",
      "compare",
      "fetch_result",
      "normalize_result",
      "emit_report_metadata"
    ]);
    expect(report.providers.find((provider) => provider.providerId === "percy")?.missingEnv).toEqual(["PERCY_TOKEN"]);
    expect(report.providers.find((provider) => provider.providerId === "argos")?.normalized).toMatchObject({
      networkMode: "deferred",
      externalCallsMade: 0,
      hostedVisual: {
        provider: "argos",
        projectId: "visual-hive/demo",
        baselinePolicy: "provider-owned-future"
      }
    });
    expect(report.providers.find((provider) => provider.providerId === "storybook")?.normalized.storybook).toMatchObject({
      mode: "mock",
      recommendedCommand: "npm run storybook -- --ci"
    });
    expect(report.providers.find((provider) => provider.providerId === "github-checks")?.normalized.githubChecks).toMatchObject({
      checkName: "Visual Hive",
      conclusion: "success",
      trustedIssueWorkflowRequired: true
    });
    expect(report.providers.every((provider) => provider.normalized.externalCallsMade === 0)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("super-secret-token-value");
  });

  it("exposes a provider adapter registry for every built-in provider", () => {
    const adapters = listProviderAdapters();

    expect(adapters.map((adapter) => adapter.id).sort()).toEqual(
      ["applitools", "argos", "chromatic", "github-checks", "percy", "playwright", "storybook"].sort()
    );
    for (const adapter of adapters) {
      expect(adapter.supportedOperations).toContain("availability");
      expect(adapter.supportedOperations).toContain("normalize_result");
      expect(adapter.supportedOperations).toContain("emit_report_metadata");
      expect(typeof adapter.checkAvailability).toBe("function");
      expect(typeof adapter.uploadArtifact).toBe("function");
      expect(typeof adapter.compare).toBe("function");
      expect(typeof adapter.fetchResult).toBe("function");
      expect(typeof adapter.normalizeResult).toBe("function");
      expect(typeof adapter.emitReportMetadata).toBe("function");
    }
    expect(PROVIDER_ADAPTER_OPERATION_SEQUENCE).toEqual([
      "availability",
      "upload_artifact",
      "compare",
      "fetch_result",
      "normalize_result",
      "emit_report_metadata"
    ]);
  });

  it("builds a no-network provider handoff manifest with exact screenshot eligibility", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "handoff-fixture", type: "react-vite", defaultBranch: "main" },
      targets: {
        local: { kind: "url", url: "http://127.0.0.1:4173", prSafe: true, cost: "cheap" }
      },
      contracts: [
        {
          id: "dashboard",
          description: "Dashboard visual contract",
          target: "local",
          severity: "critical",
          runOn: { pullRequest: true },
          screenshots: [{ name: "desktop", route: "/", viewport: "desktop" }]
        }
      ],
      providers: {
        argos: { enabled: true, projectId: "visual-hive/demo" }
      },
      costPolicy: {
        maxExternalScreenshotsPerRun: 10,
        maxMonthlyExternalScreenshots: 1000,
        externalUpload: {
          pullRequest: false,
          schedule: true,
          manual: true,
          canary: false,
          mutation: false,
          full: true,
          onFailureOnly: false,
          criticalContractsOnly: false
        }
      }
    });
    const report = reportFixture(
      repoRoot,
      ".visual-hive/artifacts/screenshots/dashboard.png",
      ".visual-hive/snapshots/dashboard.png"
    );

    const manifest = buildProviderHandoffManifest(config, report, {
      providerId: "argos",
      env: { ARGOS_TOKEN: "secret-token-value" },
      generatedAt: "2026-06-15T00:00:00.000Z"
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      project: "handoff-fixture",
      providerId: "argos",
      status: "ready",
      externalCallsMade: 0,
      readiness: {
        availability: "available",
        missingEnv: [],
        externalUploadAllowed: true,
        projectIdConfigured: true
      },
      summary: {
        screenshotArtifacts: 1,
        eligibleArtifacts: 1
      }
    });
    expect(manifest.artifacts.find((artifact) => artifact.kind === "actual_screenshot")).toMatchObject({
      path: ".visual-hive/artifacts/screenshots/dashboard.png",
      contractId: "dashboard",
      eligibleForUpload: true
    });
    expect(manifest.artifacts.find((artifact) => artifact.kind === "baseline_screenshot")?.eligibleForUpload).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("secret-token-value");
  });

  it("blocks provider handoff when provider policy or credential readiness is not satisfied", () => {
    const config = sampleConfig();
    const report = reportFixture(repoRoot, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png");

    const manifest = buildProviderHandoffManifest(config, report, {
      providerId: "argos",
      generatedAt: "2026-06-15T00:00:00.000Z"
    });

    expect(manifest.status).toBe("blocked");
    expect(manifest.summary.eligibleArtifacts).toBe(0);
    expect(manifest.artifacts.find((artifact) => artifact.kind === "actual_screenshot")?.blockedReasons.join(" ")).toContain("Provider is disabled");
    expect(manifest.externalCallsMade).toBe(0);
  });

  it("skips disabled Argos upload without external commands", async () => {
    const { rootDir, report } = await providerUploadFixture();
    let calls = 0;

    const result = await uploadProviderArtifacts(sampleConfig(), {
      providerId: "argos",
      rootDir,
      report,
      dryRun: true,
      commandRunner: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      generatedAt: "2026-06-16T00:00:00.000Z"
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.status).toBe("skipped");
    expect(result.manifest.externalCallsMade).toBe(0);
    expect(result.manifest.summary.stagedArtifacts).toBe(0);
    expect(calls).toBe(0);
    expect(JSON.stringify(result.providerResults)).not.toContain("ARGOS_TOKEN=");
  });

  it("reports missing Argos credential name without leaking values", async () => {
    const { rootDir, report } = await providerUploadFixture();

    const result = await uploadProviderArtifacts(argosEnabledConfig(), {
      providerId: "argos",
      rootDir,
      report,
      env: {},
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      generatedAt: "2026-06-16T00:00:00.000Z"
    });

    expect(result.manifest.status).toBe("missing_credentials");
    expect(result.manifest.readiness.missingEnv).toEqual(["ARGOS_TOKEN"]);
    expect(result.manifest.externalCallsMade).toBe(0);
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
  });

  it("blocks Argos upload by cost policy without external commands", async () => {
    const { rootDir, report } = await providerUploadFixture();
    let calls = 0;

    const result = await uploadProviderArtifacts(
      VisualHiveConfigSchema.parse({
        ...sampleConfig(),
        providers: { argos: { enabled: true } }
      }),
      {
        providerId: "argos",
        rootDir,
        report,
        env: { ARGOS_TOKEN: "secret-token-value" },
        commandRunner: async () => {
          calls += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        generatedAt: "2026-06-16T00:00:00.000Z"
      }
    );

    expect(result.manifest.status).toBe("blocked");
    expect(result.manifest.blockedReasons.join(" ")).toContain("maxExternalScreenshotsPerRun 0");
    expect(result.manifest.externalCallsMade).toBe(0);
    expect(calls).toBe(0);
  });

  it("stages Argos dry-run artifacts without external commands", async () => {
    const { rootDir, report } = await providerUploadFixture();
    let calls = 0;

    const result = await uploadProviderArtifacts(argosEnabledConfig({ includeTextArtifacts: true }), {
      providerId: "argos",
      rootDir,
      report,
      dryRun: true,
      env: {},
      commandRunner: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      generatedAt: "2026-06-16T00:00:00.000Z"
    });

    expect(result.manifest.status).toBe("dry_run");
    expect(result.manifest.summary.actualScreenshots).toBe(1);
    expect(result.manifest.summary.textArtifacts).toBe(1);
    expect(result.manifest.stagedArtifacts.some((artifact) => artifact.stagedPath.includes("provider-upload/argos/screenshots"))).toBe(true);
    expect(result.providerResults.providers.find((provider) => provider.providerId === "argos")?.result.upload).toMatchObject({
      status: "dry_run",
      externalCallsMade: 0,
      stagedArtifacts: 2
    });
    expect(calls).toBe(0);
  });

  it("records mocked successful Argos upload evidence with sanitized output", async () => {
    const { rootDir, report } = await providerUploadFixture();

    const result = await uploadProviderArtifacts(argosEnabledConfig(), {
      providerId: "argos",
      rootDir,
      report,
      env: { ARGOS_TOKEN: "secret-token-value" },
      commandRunner: async (input) => {
        expect(input.env.ARGOS_TOKEN).toBe("secret-token-value");
        return {
          exitCode: 0,
          stdout: "Uploaded to https://app.argos-ci.com/project/demo/builds/123?token=secret-token-value",
          stderr: "authorization: Bearer secret-token-value"
        };
      },
      generatedAt: "2026-06-16T00:00:00.000Z"
    });

    const argos = result.providerResults.providers.find((provider) => provider.providerId === "argos");
    expect(result.manifest.status).toBe("uploaded");
    expect(result.manifest.externalCallsMade).toBe(1);
    expect(result.manifest.summary.uploadedArtifacts).toBe(1);
    expect(argos?.normalized).toMatchObject({
      networkMode: "external",
      externalCallsMade: 1,
      artifactSummary: {
        uploadMode: "uploaded",
        uploadedArtifacts: 1
      }
    });
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("records mocked failed Argos upload without changing deterministic status", async () => {
    const { rootDir, report } = await providerUploadFixture();

    const result = await uploadProviderArtifacts(argosEnabledConfig(), {
      providerId: "argos",
      rootDir,
      report,
      env: { ARGOS_TOKEN: "secret-token-value" },
      failOnProviderFailure: true,
      commandRunner: async () => ({
        exitCode: 2,
        stdout: "",
        stderr: "ARGOS_TOKEN=secret-token-value upload failed"
      }),
      generatedAt: "2026-06-16T00:00:00.000Z"
    });

    const argos = result.providerResults.providers.find((provider) => provider.providerId === "argos");
    expect(result.exitCode).toBe(1);
    expect(result.manifest.status).toBe("failed");
    expect(result.manifest.deterministicStatus).toBe(report.status);
    expect(argos?.result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
  });

  it("records provider governance decisions in core without leaking secrets or making external calls", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-provider-decision-"));
    tempDirs.push(tempRoot);
    const decisionPath = path.join(tempRoot, ".visual-hive", "provider-decisions.json");

    const result = await recordProviderDecision(decisionPath, {
      providerId: "argos",
      label: "Argos",
      decision: "review_later",
      reason: "Review after ARGOS_TOKEN=abc123 and client_secret=hidden are configured.",
      source: "control-plane",
      now: new Date("2026-06-16T00:00:00.000Z")
    });
    const log = await readProviderDecisionLog(decisionPath);

    expect(result.decisionPath).toBe(".visual-hive/provider-decisions.json");
    expect(result.decision).toMatchObject({
      providerId: "argos",
      label: "Argos",
      decision: "review_later",
      source: "control-plane",
      externalCallsMade: 0
    });
    expect(result.decision.reason).toContain("[REDACTED]");
    expect(JSON.stringify(log)).not.toContain("abc123");
    expect(JSON.stringify(log)).not.toContain("hidden");
    expect(log?.outputResource).toMatchObject({
      artifactPath: ".visual-hive/provider-decisions.json",
      evidenceResourceId: "provider-decisions",
      evidenceResourceUri: "visual-hive://provider-decisions",
      evidenceReadToolName: "visual_hive_read_provider_decisions"
    });
    expect(log?.decisions[0].externalCallsMade).toBe(0);
  });

  it("defaults protected target cost to expensive", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "protected-default" },
      targets: {
        live: {
          kind: "protected",
          url: "https://example.com"
        }
      },
      contracts: [{ id: "live", description: "Live", target: "live" }]
    });

    expect(config.targets.live.cost).toBe("expensive");
    expect(config.targets.live.prSafe).toBe(false);
  });

  it("supports deploy preview targets with PR-safe cheap defaults", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "deploy-preview-default" },
      targets: {
        preview: {
          kind: "deployPreview",
          provider: "vercel",
          urlEnv: "VERCEL_URL"
        }
      },
      contracts: [{ id: "preview", description: "Preview", target: "preview" }]
    });

    expect(config.targets.preview.kind).toBe("deployPreview");
    expect(config.targets.preview.prSafe).toBe(true);
    expect(config.targets.preview.cost).toBe("cheap");
    expect(resolveTargetUrl(config.targets.preview, { VERCEL_URL: "visual-hive-preview.vercel.app" }).url).toBe(
      "https://visual-hive-preview.vercel.app"
    );
  });

  it("uses deploy preview templates and fallback URLs without exposing env values in reasons", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "deploy-preview-template" },
      targets: {
        preview: {
          kind: "deployPreview",
          provider: "custom",
          urlEnv: "PREVIEW_HOST",
          urlTemplate: "https://${PREVIEW_HOST}/console",
          fallbackUrl: "https://fallback.example.com"
        }
      },
      contracts: [{ id: "preview", description: "Preview", target: "preview" }]
    });

    expect(resolveTargetUrl(config.targets.preview, { PREVIEW_HOST: "pr-12.example.com" }).url).toBe("https://pr-12.example.com/console");
    expect(resolveTargetUrl(config.targets.preview, {}).url).toBe("https://fallback.example.com");
  });

  it("rejects unsafe visual artifact paths", () => {
    expect(() =>
      VisualHiveConfigSchema.parse({
        project: { name: "bad-paths" },
        targets: { local: { kind: "url", url: "http://127.0.0.1:4173" } },
        contracts: [{ id: "home", description: "Home", target: "local" }],
        visual: { snapshotDir: "../snapshots" }
      })
    ).toThrow(/repo-relative/);
  });

  it("rejects an invalid config", () => {
    expect(() =>
      VisualHiveConfigSchema.parse({
        project: { name: "", type: "react-vite", defaultBranch: "main" },
        targets: {},
        contracts: []
      })
    ).toThrow();
  });

  it("returns an excellent missing config error", async () => {
    await expect(loadConfig("missing.yaml", repoRoot)).rejects.toThrow(/Missing Visual Hive config/);
  });

  it("parses config text with the same reference validation as file loading", () => {
    expect(() =>
      parseConfigText(
        `project:
  name: draft
targets:
  local:
    kind: url
    url: "http://127.0.0.1:4173"
contracts:
  - id: broken
    description: Broken
    target: missing
`,
        "draft.yaml"
      )
    ).toThrow(/Invalid target reference/);
  });

  it("returns an excellent invalid target reference error", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-core-"));
    tempDirs.push(tempRoot);
    const configPath = path.join(tempRoot, "visual-hive.config.yaml");
    await writeFile(
      configPath,
      `project:
  name: invalid-target
targets:
  local:
    kind: url
    url: "http://127.0.0.1:4173"
contracts:
  - id: broken
    description: Broken target ref
    target: missingTarget
`,
      "utf8"
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/Invalid target reference/);
  });

  it("validates the KubeStellar example config", async () => {
    const loaded = await loadConfig("examples/kubestellar-console/visual-hive.config.yaml", repoRoot);
    expect(loaded.config.targets.liveCluster.kind).toBe("protected");
    expect(loaded.config.targets.fakeOAuthFullstack.kind).toBe("commandGroup");
  });

  it("selects expected KubeStellar contracts from sample changed files", async () => {
    const loaded = await loadConfig("examples/kubestellar-console/visual-hive.config.yaml", repoRoot);
    const authPlan = createPlan(loaded.config, {
      mode: "pr",
      changedFiles: ["web/src/features/auth/LoginPage.tsx"]
    });
    expect(authPlan.items.map((item) => item.contractId)).toEqual(
      expect.arrayContaining(["fake-oauth-login-dashboard", "hosted-demo-never-login", "local-login-visible-when-oauth-enabled"])
    );
    expect(authPlan.items.map((item) => item.contractId)).not.toContain("live-cluster-picker-renders");

    const docsPlan = createPlan(loaded.config, {
      mode: "pr",
      changedFiles: ["docs/getting-started.md"]
    });
    expect(docsPlan.items).toEqual([]);
    expect(docsPlan.effectiveChangedFiles).toEqual([]);
    expect(docsPlan.ignoredChangedFiles[0]).toMatchObject({ file: "docs/getting-started.md", pattern: "docs/**" });
    expect(docsPlan.excluded.map((item) => item.reasons.join(";"))).toContainEqual(
      expect.stringContaining("all changed files matched selection.ignoreChangedFiles")
    );

    const schedulePlan = createPlan(loaded.config, { mode: "schedule" });
    expect(schedulePlan.items.map((item) => item.contractId)).toEqual(
      expect.arrayContaining(["live-cluster-picker-renders", "live-workloads-renders"])
    );
    expect(schedulePlan.targets.find((target) => target.id === "liveCluster")).toMatchObject({
      kind: "protected",
      requiresSecrets: ["KUBECONFIG", "KC_AGENT_TOKEN"]
    });
    expect(schedulePlan.mutation.enabled).toBe(true);
  });
});

describe("schema catalog", () => {
  it("includes JSON schemas for every documented governance artifact", async () => {
    const schemaNames = new Set((await readdir(path.join(repoRoot, "schemas"))).filter((name) => name.endsWith(".schema.json")));

    expect(schemaNames).toContain("visual-hive.provider-decisions.schema.json");
    expect(schemaNames).toContain("visual-hive.llm-decisions.schema.json");
    expect(schemaNames).toContain("visual-hive.flows.schema.json");
    expect(schemaNames).toContain("visual-hive.connections-portfolio.schema.json");
    expect(schemaNames).toContain("visual-hive.runbook.schema.json");
    expect(schemaNames).toContain("visual-hive.plans.schema.json");
    expect(schemaNames).toContain("visual-hive.setup-pr-plan.schema.json");
    expect(schemaNames).toContain("visual-hive.provider-handoff.schema.json");
    expect(schemaNames).toContain("visual-hive.evidence-packet.schema.json");
    expect(schemaNames).toContain("visual-hive.handoff.schema.json");
    expect(schemaNames).toContain("visual-hive.ux-scout-context.schema.json");
    expect(schemaNames).toContain("visual-hive.agent-packet.schema.json");
    expect(schemaNames).toContain("visual-hive.tool-registry.schema.json");
    expect(schemaNames).toContain("visual-hive.mcp.schema.json");
    expect(schemaNames).toContain("visual-hive.context-ledger.schema.json");
    expect(schemaNames).toContain("visual-hive.pipeline.schema.json");
    expect(schemaNames).toContain("visual-hive.handoff-validation.schema.json");
    expect(schemaNames).toContain("visual-hive.repo-map.schema.json");
    expect(schemaNames).toContain("visual-hive.testing-layers.schema.json");
    expect(schemaNames).toContain("visual-hive.test-creation-plan.schema.json");
    expect(schemaNames).toContain("visual-hive.verdict.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-bead-request.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-handoff-result.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-beads.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-knowledge-facts.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-knowledge-graph.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-wiki-index.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-repair-work-orders.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-agent-policy.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-guarded-repair-preview.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-repair-request-envelope.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-trusted-repair-consumer-summary.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-trusted-repair-workflow-dry-run.schema.json");
    expect(schemaNames).toContain("visual-hive.hive-mode-comparison.schema.json");

    const providerSchema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.provider-decisions.schema.json"), "utf8")) as {
      properties: { decisions: { items: { $ref: string } } };
      $defs: { decision: { properties: Record<string, unknown> } };
    };
    const llmSchema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.llm-decisions.schema.json"), "utf8")) as {
      $defs: { decision: { properties: Record<string, unknown> } };
    };

    expect(providerSchema.$defs.decision.properties.externalCallsMade).toEqual({ const: 0 });
    expect(llmSchema.$defs.decision.properties.externalCallsMade).toEqual({ const: 0 });
    expect(providerSchema.$defs.decision.properties.source).toEqual({ enum: ["cli", "control-plane"] });
    expect(llmSchema.$defs.decision.properties.source).toEqual({ enum: ["cli", "control-plane"] });

    for (const schemaName of schemaNames) {
      const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", schemaName), "utf8")) as { $id?: string };
      expect(schema.$id, schemaName).toBe(`https://visual-hive.dev/schemas/${schemaName}`);
    }
  });
});

describe("repo intelligence", () => {
  it("maps repo scripts, selectors, routes, workflows, target hints, and coverage gaps", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-repo-map-"));
    tempDirs.push(tempRoot);
    await mkdir(path.join(tempRoot, "src"), { recursive: true });
    await mkdir(path.join(tempRoot, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify(
        {
          name: "repo-map-fixture",
          private: true,
          workspaces: ["packages/*"],
          scripts: {
            build: "vite build",
            preview: "vite preview --host 127.0.0.1 --port 4173",
            test: "vitest run"
          },
          dependencies: { react: "^19.0.0", vite: "^6.0.0" },
          devDependencies: { vitest: "^2.0.0", "@playwright/test": "^1.0.0" }
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(path.join(tempRoot, "package-lock.json"), "{}", "utf8");
    await writeFile(
      path.join(tempRoot, "src", "App.tsx"),
      `export function App() { return <main><a href="/clusters" data-testid="dashboard-page">Clusters</a><button data-testid='critical-action-button'>Run</button></main>; }`,
      "utf8"
    );
    await writeFile(
      path.join(tempRoot, "visual-hive.config.yaml"),
      `project:
  name: repo-map-fixture
  type: react-vite
  defaultBranch: main
targets:
  localPreview:
    kind: command
    serve: "npm run preview -- --host 127.0.0.1 --port 4173"
    url: "http://127.0.0.1:4173"
    prSafe: true
    cost: cheap
contracts:
  - id: dashboard-shell
    description: Dashboard shell should render.
    target: localPreview
    severity: high
    runOn:
      pullRequest: true
      schedule: true
    selectors:
      mustExist:
        - "[data-testid='dashboard-page']"
        - "[data-testid='critical-action-button']"
    screenshots:
      - name: dashboard-desktop
        route: "/clusters?issue=empty-data"
        viewport: desktop
viewports:
  desktop:
    width: 1440
    height: 900
selection:
  changedFiles:
    - pattern: "src/**"
      contracts:
        - dashboard-shell
      risk: high
mutation:
  enabled: true
  minScore: 0.7
  operators:
    - id: hide-critical-button
      contracts:
        - dashboard-shell
`,
      "utf8"
    );
    await writeFile(
      path.join(tempRoot, ".github", "workflows", "unsafe.yml"),
      `name: unsafe
on: pull_request_target
permissions:
  contents: write
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.SECRET_TOKEN }}"
`,
      "utf8"
    );

    const report = await analyzeRepository({ repoRoot: tempRoot, now: new Date("2026-06-15T00:00:00.000Z") });

    expect(report.project).toMatchObject({
      name: "repo-map-fixture",
      packageManager: "npm",
      workspaces: ["packages/*"],
      frameworks: ["react", "vite"]
    });
    expect(report.scripts.map((script) => script.name)).toEqual(expect.arrayContaining(["build", "preview", "test"]));
    expect(report.selectors.map((selector) => selector.selector)).toEqual(
      expect.arrayContaining(["[data-testid='dashboard-page']", "[data-testid='critical-action-button']"])
    );
    expect(report.routes.map((route) => route.route)).toContain("/clusters");
    expect(report.testTools).toEqual(expect.arrayContaining(["playwright", "vitest"]));
    expect(report.targetHints.find((hint) => hint.id === "localPreview")).toMatchObject({ kind: "command", confidence: "high" });
    expect(report.workflows[0]).toMatchObject({ usesPullRequestTarget: true, usesSecrets: true });
    expect(report.riskSignals.map((risk) => risk.id)).toContain("workflow_pull_request_target");
    expect(report.riskSignals.map((risk) => risk.id)).not.toContain("missing_visual_hive_config");
    expect(report.outputResource).toMatchObject({
      artifactPath: ".visual-hive/repo-map.json",
      evidenceResourceId: "repo-map",
      evidenceResourceUri: "visual-hive://repo-map",
      evidenceReadToolName: "visual_hive_read_repo_map"
    });
    expect(report.visualMap.lifecycle).toBe("File -> Component -> Layout -> Route -> State -> Viewport -> Target -> Contract -> Screenshot -> Mutation -> Issue");
    expect(report.visualMap.summary).toMatchObject({
      routes: expect.any(Number),
      components: expect.any(Number),
      contracts: 1,
      screenshots: 1,
      mutations: 1
    });
    expect(report.visualMap.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "file:src/App.tsx",
        "component:app",
        "target:localPreview",
        "contract:dashboard-shell",
        "route:clusters-issue-empty-data",
        "state:empty-data",
        "viewport:desktop",
        "screenshot:dashboard-shell:dashboard-desktop:desktop",
        "mutation:hide-critical-button"
      ])
    );
    expect(report.visualMap.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "file:src/App.tsx", to: "component:app", relation: "declares" }),
        expect.objectContaining({ from: "contract:dashboard-shell", to: "target:localPreview", relation: "targets" }),
        expect.objectContaining({ from: "contract:dashboard-shell", to: "route:clusters-issue-empty-data", relation: "covers_route" }),
        expect.objectContaining({ from: "contract:dashboard-shell", to: "screenshot:dashboard-shell:dashboard-desktop:desktop", relation: "captures" }),
        expect.objectContaining({ from: "mutation:hide-critical-button", to: "contract:dashboard-shell", relation: "maps_mutation" }),
        expect.objectContaining({ from: "file:src/App.tsx", to: "contract:dashboard-shell", relation: "impacts" })
      ])
    );
    expect(report.visualMap.findings.every((finding) => finding.fingerprint)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("SECRET_TOKEN");
  });

  it("writes repo-map JSON and repo-context Markdown", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-repo-map-write-"));
    tempDirs.push(tempRoot);
    await writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ name: "repo-map-write", scripts: { dev: "vite dev" }, dependencies: { vite: "^6.0.0" } }), "utf8");

    const result = await writeRepoMap({
      repoRoot: tempRoot,
      now: new Date("2026-06-15T00:00:00.000Z")
    });

    expect(result.reportPath).toBe(path.join(tempRoot, ".visual-hive", "repo-map.json"));
    expect(result.markdownPath).toBe(path.join(tempRoot, ".visual-hive", "repo-context.md"));
    const repoMapJson = await readFile(result.reportPath, "utf8");
    expect(repoMapJson).toContain('"schemaVersion": 1');
    expect(JSON.parse(repoMapJson)).toMatchObject({
      outputResource: {
        artifactPath: ".visual-hive/repo-map.json",
        evidenceResourceId: "repo-map",
        evidenceResourceUri: "visual-hive://repo-map",
        evidenceReadToolName: "visual_hive_read_repo_map"
      }
    });
    expect(await readFile(result.markdownPath, "utf8")).toContain("Visual Hive Repo Context: repo-map-write");
  });

  it("writes Visual Graph artifacts with searchable nodes, unresolved references, and impact evidence", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-visual-graph-"));
    tempDirs.push(tempRoot);
    await mkdir(path.join(tempRoot, "src"), { recursive: true });
    await writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ name: "visual-graph-fixture", scripts: { preview: "vite preview" }, dependencies: { react: "^19.0.0", vite: "^6.0.0" } }), "utf8");
    await writeFile(
      path.join(tempRoot, "visual-hive.config.yaml"),
      `project:
  name: visual-graph-fixture
  type: react-vite
targets:
  localPreview:
    kind: url
    url: http://127.0.0.1:4173
    prSafe: true
contracts:
  - id: hosted-demo-never-login
    description: Public demo never exposes login
    target: localPreview
    runOn:
      pullRequest: true
    selectors:
      mustExist:
        - "[data-testid='dashboard-page']"
      mustNotExist:
        - "[data-testid='login-page']"
        - "[data-testid='github-login-button']"
    screenshots:
      - name: dashboard-mobile
        route: /
        viewport: mobile
viewports:
  mobile:
    width: 390
    height: 844
mutation:
  enabled: true
  operators:
    - force-login-on-demo
`,
      "utf8"
    );
    await writeFile(
      path.join(tempRoot, "src", "App.tsx"),
      `export function App() {
  return <main data-testid="dashboard-page"><button data-testid="github-login-button">GitHub</button></main>;
}
`,
      "utf8"
    );

    await writeRepoMap({ repoRoot: tempRoot, now: new Date("2026-06-15T00:00:00.000Z") });
    const graph = await readVisualGraph(tempRoot);
    const vocab = JSON.parse(await readFile(path.join(tempRoot, ".visual-hive", "visual-graph-vocab.json"), "utf8"));
    const unresolved = JSON.parse(await readFile(path.join(tempRoot, ".visual-hive", "visual-graph-unresolved.json"), "utf8"));

    await expectMatchesSchema("visual-hive.visual-graph.schema.json", graph);
    await expectMatchesSchema("visual-hive.visual-graph-vocab.schema.json", vocab);
    await expectMatchesSchema("visual-hive.visual-graph-unresolved.schema.json", unresolved);
    expect(VISUAL_HIVE_GRAPH_EXTRACTORS.map((extractor) => extractor.id)).toEqual(
      expect.arrayContaining([
        "visual-hive-config",
        "react-vite",
        "react-router",
        "storybook",
        "github-actions",
        "playwright-report-artifact",
        "mutation-report-artifact",
        "baseline-artifact",
        "issue-artifact"
      ])
    );
    expect(graph.extractorArchitecture.extractors).toEqual(expect.arrayContaining(["visual-hive-config", "react-vite", "react-router"]));
    expect(graph.extractorArchitecture.notes.join(" ")).toContain("Detected extractor registry");
    expect(graph.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(["file", "component", "route", "contract", "screenshot", "mutation_operator", "artifact", "agent_profile", "hive_resource"]));
    expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ relation: "captures" }), expect.objectContaining({ relation: "mutates" })]));
    expect(graph.summary.completeChains).toBeGreaterThanOrEqual(1);
    expect(searchVisualGraph(graph, "login").map((result) => result.node.id)).toEqual(expect.arrayContaining(["selector:data-testid-login-page", "selector:data-testid-github-login-button"]));

    const impact = analyzeVisualImpact(graph, { changedFiles: ["src/App.tsx"], mutation: "force-login-on-demo" }, new Date("2026-06-15T00:00:00.000Z"));
    await expectMatchesSchema("visual-hive.visual-impact.schema.json", impact);
    expect(impact.summary.affectedContractCount).toBeGreaterThanOrEqual(1);
    expect(impact.validationCommands.length).toBeGreaterThanOrEqual(1);
  });

  it("detects graph extractors from external-repo-style source, workflow, storybook, and artifact evidence", async () => {
    const repoMap = await analyzeRepository({
      repoRoot: path.join(sourceRepoRoot, "examples", "demo-react-app"),
      now: new Date("2026-06-15T00:00:00.000Z")
    });
    const detected = detectVisualGraphExtractors(repoMap, [
      ".github/workflows/visual-hive-pr.yml",
      ".storybook/main.ts",
      "src/App.stories.tsx",
      ".visual-hive/report.json",
      ".visual-hive/mutation-report.json",
      ".visual-hive/issues.json",
      ".visual-hive/snapshots/dashboard.png"
    ]).map((extractor) => extractor.id);

    expect(detected).toEqual(
      expect.arrayContaining([
        "visual-hive-config",
        "react-vite",
        "react-router",
        "storybook",
        "github-actions",
        "playwright-report-artifact",
        "mutation-report-artifact",
        "baseline-artifact",
        "issue-artifact"
      ])
    );
  });

  it("sanitizes absolute screenshot paths in Visual Graph and vocabulary artifacts", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-graph-paths-"));
    tempDirs.push(tempRoot);
    await mkdir(path.join(tempRoot, "src"), { recursive: true });
    await writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ name: "graph-paths", scripts: { preview: "vite preview" } }), "utf8");
    await writeFile(path.join(tempRoot, "src", "App.tsx"), "export function App() { return <main data-testid=\"dashboard-page\" />; }\n", "utf8");

    const repoMap = await analyzeRepository({
      repoRoot: tempRoot,
      now: new Date("2026-06-15T00:00:00.000Z")
    });
    const actualPath = path.join(tempRoot, ".visual-hive", "artifacts", "screenshots", "dashboard.png");
    const baselinePath = path.join(tempRoot, ".visual-hive", "snapshots", "dashboard.png");
    const report = reportFixture(tempRoot, actualPath, baselinePath);

    const result = await writeVisualGraphArtifacts({
      repoRoot: tempRoot,
      repoMap,
      report,
      now: new Date("2026-06-15T00:01:00.000Z")
    });

    const graphText = await readFile(result.graphPath, "utf8");
    const vocabText = await readFile(result.vocabPath, "utf8");
    expect(graphText).toContain(".visual-hive/artifacts/screenshots/dashboard.png");
    expect(graphText).toContain(".visual-hive/snapshots/dashboard.png");
    expect(graphText).not.toContain(tempRoot.replaceAll("\\", "\\\\"));
    expect(graphText).not.toContain(tempRoot.replaceAll("\\", "/"));
    expect(vocabText).not.toContain("C__Users");
    expect(vocabText).not.toContain("OneDrive");
    expect(vocabText).not.toContain(tempRoot.replaceAll("\\", "\\\\"));
    expect(vocabText).not.toContain(tempRoot.replaceAll("\\", "/"));
  });

  it("reconciles previous visual-map findings by fingerprint", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-repo-map-lifecycle-"));
    tempDirs.push(tempRoot);
    await writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ name: "repo-map-lifecycle", scripts: { preview: "vite preview" }, dependencies: { vite: "^6.0.0" } }), "utf8");

    const first = await writeRepoMap({
      repoRoot: tempRoot,
      now: new Date("2026-06-15T00:00:00.000Z")
    });
    expect(first.report.visualMap.findings.find((finding) => finding.id === "coverage_gap:repo-intelligence-config")).toMatchObject({
      status: "active",
      previouslySeen: false,
      firstSeen: "2026-06-15T00:00:00.000Z"
    });

    await writeFile(
      path.join(tempRoot, "visual-hive.config.yaml"),
      `project:
  name: repo-map-lifecycle
  type: static
  defaultBranch: main
targets:
  local:
    kind: url
    url: http://127.0.0.1:4173
    prSafe: true
contracts:
  - id: smoke
    description: Smoke contract
    target: local
    runOn:
      pullRequest: true
    selectors:
      mustExist:
        - body
viewports:
  desktop:
    width: 1280
    height: 720
`,
      "utf8"
    );

    const second = await writeRepoMap({
      repoRoot: tempRoot,
      now: new Date("2026-06-16T00:00:00.000Z")
    });
    const resolved = second.report.visualMap.findings.find((finding) => finding.id === "resolved_candidate:coverage_gap:repo-intelligence-config");
    expect(resolved).toMatchObject({
      status: "resolved_candidate",
      previouslySeen: true,
      firstSeen: "2026-06-15T00:00:00.000Z",
      lastSeen: "2026-06-15T00:00:00.000Z"
    });
    expect(resolved?.evidence).toEqual(expect.arrayContaining(["reconciledAt=2026-06-16T00:00:00.000Z"]));
  });
});

describe("planner", () => {
  it("selects PR-safe contracts for PR mode", () => {
    const plan = createPlan(sampleConfig(), { mode: "pr", changedFiles: [] });
    expect(plan.items.map((item) => item.contractId)).toContain("safe-contract");
  });

  it("records provider availability and cost policy in plans without planning external calls", () => {
    const config = sampleConfig();
    config.providers.argos = {
      ...config.providers.argos,
      enabled: true
    };

    const plan = createPlan(config, { mode: "pr", changedFiles: [], env: { ARGOS_TOKEN: "secret-value" } });
    const playwright = plan.providerPolicy.find((provider) => provider.providerId === "playwright");
    const argos = plan.providerPolicy.find((provider) => provider.providerId === "argos");

    expect(playwright).toMatchObject({
      availability: "available",
      externalUploadAllowed: true,
      externalCallsPlanned: 0
    });
    expect(argos).toMatchObject({
      availability: "policy_blocked",
      missingEnv: [],
      externalUploadAllowed: false,
      estimatedExternalScreenshots: 1,
      externalCallsPlanned: 0
    });
    expect(argos?.externalUploadBlockedReasons.join(" ")).toContain("pullRequest=false");
    expect(JSON.stringify(plan.providerPolicy)).not.toContain("secret-value");
  });

  it("excludes unsafe targets unless allowed", () => {
    const plan = createPlan(sampleConfig(), { mode: "pr", changedFiles: [] });
    expect(plan.items.map((item) => item.contractId)).not.toContain("unsafe-contract");
    expect(plan.excluded[0]?.contractId).toBe("unsafe-contract");

    const allowed = createPlan(sampleConfig(), { mode: "pr", changedFiles: [], allowUnsafeTargets: true });
    expect(allowed.items.map((item) => item.contractId)).toContain("unsafe-contract");
  });

  it("selects scheduled contracts in schedule mode", () => {
    const plan = createPlan(sampleConfig(), { mode: "schedule", changedFiles: [] });
    expect(plan.items.map((item) => item.contractId)).toEqual(["safe-contract", "unsafe-contract"]);
    expect(plan.mutation.enabled).toBe(true);
  });

  it("excludes deploy preview contracts when the URL env var is missing", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "deploy-preview-plan" },
      targets: {
        preview: {
          kind: "deployPreview",
          provider: "vercel",
          urlEnv: "VERCEL_URL"
        }
      },
      contracts: [
        {
          id: "preview-dashboard",
          description: "Preview dashboard",
          target: "preview",
          runOn: { pullRequest: true }
        }
      ]
    });

    const missing = createPlan(config, { mode: "pr", changedFiles: [], env: {} });
    expect(missing.items).toEqual([]);
    expect(missing.excluded[0]).toMatchObject({
      contractId: "preview-dashboard",
      reasons: expect.arrayContaining(["Deploy preview URL env var VERCEL_URL is not set and no fallbackUrl is configured."])
    });

    const resolved = createPlan(config, { mode: "pr", changedFiles: [], env: { VERCEL_URL: "preview.example.com" } });
    expect(resolved.items[0]).toMatchObject({
      contractId: "preview-dashboard",
      targetUrl: "https://preview.example.com"
    });
    expect(resolved.targets[0]).toMatchObject({
      kind: "deployPreview",
      url: "https://preview.example.com",
      prSafe: true,
      cost: "cheap"
    });
  });

  it("selects cheap scheduled PR-safe contracts in canary mode", () => {
    const config = sampleConfig();
    config.targets.safe = { ...config.targets.safe, schedule: "*/15 * * * *", cost: "cheap" };
    config.targets.unsafe = { ...config.targets.unsafe, schedule: "*/15 * * * *", cost: "expensive" };

    const plan = createPlan(config, { mode: "canary", changedFiles: [] });

    expect(plan.items.map((item) => item.contractId)).toEqual(["safe-contract"]);
    expect(plan.items[0]?.reasons).toContain("mode=canary");
    expect(plan.items[0]?.reasons).toContain("cost is not expensive");
    expect(plan.excluded.find((item) => item.contractId === "unsafe-contract")?.reasons).toContain("target.prSafe=false");
    expect(plan.mutation.enabled).toBe(false);
  });

  it("selects mutation-applicable PR-safe contracts in mutation mode", () => {
    const config = sampleConfig();
    config.contracts = [
      {
        id: "critical-action",
        description: "Critical action is present",
        target: "safe",
        severity: "high",
        runOn: { pullRequest: false, schedule: false },
        waitFor: [],
        steps: [],
        failOnConsoleError: false,
        expectedConsoleErrors: [],
        selectors: {
          mustExist: ["[data-testid='critical-action-button']"],
          mustNotExist: [],
          textMustExist: [],
          textMustNotExist: []
        },
        screenshots: []
      },
      {
        id: "unsafe-login",
        description: "Unsafe login target",
        target: "unsafe",
        severity: "critical",
        runOn: { pullRequest: false, schedule: false },
        waitFor: [],
        steps: [],
        failOnConsoleError: false,
        expectedConsoleErrors: [],
        selectors: {
          mustExist: [],
          mustNotExist: ["[data-testid='login-page']"],
          textMustExist: [],
          textMustNotExist: []
        },
        screenshots: []
      }
    ];
    config.mutation.operators = ["hide-critical-button", "force-login-on-demo"];

    const plan = createPlan(config, { mode: "mutation", changedFiles: [] });

    expect(plan.items.map((item) => item.contractId)).toEqual(["critical-action"]);
    expect(plan.items[0]?.reasons.join(";")).toContain("mutation-mode:hide-critical-button");
    expect(plan.excluded.find((item) => item.contractId === "unsafe-login")?.reasons).toContain("target.prSafe=false");
    expect(plan.mutation.enabled).toBe(true);
  });

  it("selects all PR-safe contracts in explicit full mode by default", () => {
    const plan = createPlan(sampleConfig(), { mode: "full", changedFiles: [] });

    expect(plan.items.map((item) => item.contractId).sort()).toEqual(["changed-contract", "safe-contract"]);
    expect(plan.excluded.find((item) => item.contractId === "unsafe-contract")?.reasons).toContain("target.prSafe=false");
    expect(plan.mutation.enabled).toBe(true);
  });

  it("includes unsafe contracts in full mode only when explicitly allowed", () => {
    const plan = createPlan(sampleConfig(), { mode: "full", changedFiles: [], allowUnsafeTargets: true });

    expect(plan.items.map((item) => item.contractId).sort()).toEqual(["changed-contract", "safe-contract", "unsafe-contract"]);
    expect(plan.mutation.enabled).toBe(true);
  });

  it("summarizes sidecar plan lanes with safety and mutation signals", () => {
    const config = sampleConfig();
    config.targets.safe = { ...config.targets.safe, schedule: "*/15 * * * *" };
    const prPlan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"], now: new Date("2026-06-15T00:00:00.000Z") });
    const canaryPlan = createPlan(config, { mode: "canary", changedFiles: [], now: new Date("2026-06-15T00:00:01.000Z") });
    const fullPlan = createPlan(config, { mode: "full", changedFiles: [], now: new Date("2026-06-15T00:00:02.000Z") });

    const report = buildPlanLaneSummary(
      [
        { path: ".visual-hive/plan.json", plan: prPlan },
        { path: ".visual-hive/plan.canary.json", plan: canaryPlan },
        { path: ".visual-hive/plan.full.json", plan: fullPlan }
      ],
      new Date("2026-06-15T00:00:03.000Z")
    );

    expect(report.schemaVersion).toBe(1);
    expect(report.planCount).toBe(3);
    expect(report.summary.modes).toEqual(["canary", "full", "pr"]);
    expect(report.summary.selectedContracts).toBeGreaterThanOrEqual(2);
    expect(report.summary.unsafeExcludedContracts).toBeGreaterThan(0);
    expect(report.summary.mutationEnabledPlans).toBe(1);
    expect(report.outputResource).toMatchObject({
      artifactPath: ".visual-hive/plans.json",
      evidenceResourceId: "plan-lanes",
      evidenceResourceUri: "visual-hive://plan-lanes",
      evidenceReadToolName: "visual_hive_read_plan_lanes"
    });
    expect(report.lanes.find((lane) => lane.path.endsWith("plan.full.json"))).toMatchObject({
      mode: "full",
      mutationEnabled: true,
      status: "review"
    });
    expect(report.recommendations.join(" ")).toContain("non-PR-safe");
  });

  it("selects changed-file contracts", () => {
    const plan = createPlan(sampleConfig(), { mode: "pr", changedFiles: ["src/App.tsx"] });
    expect(plan.items.map((item) => item.contractId)).toContain("changed-contract");
  });

  it("writes an intentional empty PR plan when every changed file is ignored", () => {
    const plan = createPlan(sampleConfig(), { mode: "pr", changedFiles: ["docs/guide.md", "README.md"] });

    expect(plan.items).toEqual([]);
    expect(plan.changedFiles).toEqual(["README.md", "docs/guide.md"]);
    expect(plan.effectiveChangedFiles).toEqual([]);
    expect(plan.ignoredChangedFiles.map((entry) => entry.file)).toEqual(["README.md", "docs/guide.md"]);
    expect(plan.excluded.find((item) => item.contractId === "safe-contract")?.reasons).toContain(
      "all changed files matched selection.ignoreChangedFiles"
    );
  });

  it("keeps normal PR selection when ignored files are mixed with app changes", () => {
    const plan = createPlan(sampleConfig(), { mode: "pr", changedFiles: ["docs/guide.md", "src/App.tsx"] });

    expect(plan.effectiveChangedFiles).toEqual(["src/App.tsx"]);
    expect(plan.ignoredChangedFiles.map((entry) => entry.file)).toEqual(["docs/guide.md"]);
    expect(plan.items.map((item) => item.contractId)).toContain("safe-contract");
    expect(plan.items.map((item) => item.contractId)).toContain("changed-contract");
  });

  it("supports explicit contract and target include rules", () => {
    const plan = createPlan(sampleConfig(), {
      mode: "pr",
      changedFiles: [],
      includeContracts: ["changed-contract"],
      includeTargets: ["safe"]
    });

    const selected = plan.items.map((item) => item.contractId);
    expect(selected).toContain("safe-contract");
    expect(selected).toContain("changed-contract");
    expect(plan.items.find((item) => item.contractId === "changed-contract")?.reasons).toContain("explicit include contract");
    expect(plan.items.find((item) => item.contractId === "safe-contract")?.reasons).toContain("explicit include target");
  });

  it("supports explicit exclude rules and keeps them higher priority than includes", () => {
    const plan = createPlan(sampleConfig(), {
      mode: "pr",
      changedFiles: ["src/App.tsx"],
      includeContracts: ["changed-contract"],
      excludeContracts: ["safe-contract"],
      excludeTargets: ["safe"]
    });

    expect(plan.items).toEqual([]);
    expect(plan.excluded.find((item) => item.contractId === "safe-contract")?.reasons).toEqual([
      "explicit exclude contract",
      "explicit exclude target"
    ]);
    expect(plan.excluded.find((item) => item.contractId === "changed-contract")?.reasons).toEqual(["explicit exclude target"]);
  });

  it("does not let explicit includes bypass PR target safety", () => {
    const blocked = createPlan(sampleConfig(), {
      mode: "pr",
      changedFiles: [],
      includeContracts: ["unsafe-contract"]
    });
    expect(blocked.items.map((item) => item.contractId)).not.toContain("unsafe-contract");
    expect(blocked.excluded.find((item) => item.contractId === "unsafe-contract")?.reasons).toContain("target.prSafe=false");

    const allowed = createPlan(sampleConfig(), {
      mode: "pr",
      changedFiles: [],
      includeContracts: ["unsafe-contract"],
      allowUnsafeTargets: true
    });
    expect(allowed.items.map((item) => item.contractId)).toContain("unsafe-contract");
  });
});

describe("coverage analysis", () => {
  it("summarizes targets, selected contracts, routes, viewports, and changed-file gaps", () => {
    const config = sampleConfig();
    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx", "README.md"] });
    const coverage = analyzeCoverage(config, { plan, now: new Date("2026-06-15T00:00:00.000Z") });

    expect(coverage.schemaVersion).toBe(1);
    expect(coverage.project).toBe("sample");
    expect(coverage.outputResource).toMatchObject({
      artifactPath: ".visual-hive/coverage.json",
      evidenceResourceId: "coverage-map",
      evidenceResourceUri: "visual-hive://coverage-map",
      evidenceResourceTitle: "Coverage Map"
    });
    expect(coverage.summary).toMatchObject({
      targetCount: 2,
      contractCount: 3,
      selectedContracts: 2,
      unselectedContracts: 1,
      prSafeContracts: 2,
      protectedContracts: 0,
      routesCovered: 1,
      viewportsCovered: 1,
      matchedChangedFileRules: 1,
      unmatchedChangedFiles: 0
    });
    expect(coverage.targets.find((target) => target.id === "safe")?.selectedContractIds.sort()).toEqual(["changed-contract", "safe-contract"]);
    expect(coverage.contracts.find((contract) => contract.id === "unsafe-contract")?.excludedReasons).toContain("target.prSafe=false");
    expect(coverage.routes[0]).toMatchObject({ route: "/", contracts: ["safe-contract"], selectedContracts: ["safe-contract"] });
    expect(coverage.changedFileCoverage[0]).toMatchObject({
      pattern: "src/**",
      matchedFiles: ["src/App.tsx"],
      selectedContracts: ["changed-contract"]
    });
    expect(coverage.uncoveredAreas.map((gap) => gap.kind)).not.toContain("changed_file_without_rule");
  });

  it("builds deterministic coverage improvement recommendations from gaps and mutation survivors", () => {
    const config = sampleConfig();
    const plan = createPlan(config, { mode: "pr", changedFiles: ["scripts/build.js"] });
    const coverage = analyzeCoverage(config, { plan, changedFiles: ["scripts/build.js"], now: new Date("2026-06-15T00:00:00.000Z") });
    const report = buildCoverageImprovementReport(
      config,
      coverage,
      {
        schemaVersion: 2,
        project: "sample",
        generatedAt: "2026-06-15T00:01:00.000Z",
        minScore: 0.7,
        score: 0,
        killed: 0,
        total: 1,
        results: [
          {
            operator: "hide-critical-button",
            status: "survived",
            killed: false,
            contractIds: ["safe-contract"],
            applicable: true,
            expectedFailureKinds: ["missing_element"],
            durationMs: 25,
            errors: ["critical button remained uncovered"]
          }
        ]
      },
      { now: new Date("2026-06-15T00:02:00.000Z") }
    );

    expect(report.schemaVersion).toBe(1);
    expect(report.project).toBe("sample");
    expect(report.outputResource).toEqual({
      artifactPath: ".visual-hive/coverage-recommendations.json",
      evidenceResourceId: "coverage-recommendations",
      evidenceResourceUri: "visual-hive://coverage-recommendations",
      evidenceResourceTitle: "Coverage Recommendations",
      evidenceResourceDescription: "Deterministic no-write missing-coverage and config-improvement recommendations for human or agent review.",
      evidenceReadToolName: "visual_hive_read_coverage_recommendations"
    });
    expect(report.summary.total).toBeGreaterThan(0);
    expect(report.summary.fromMutationSurvivors).toBe(1);
    expect(report.summary.fromMaintenanceFindings).toBeGreaterThan(0);
    expect(report.maintenanceFindings.map((finding) => finding.kind)).toEqual(
      expect.arrayContaining(["generic_selector", "screenshot_without_assertion", "overbroad_full_page", "mutation_survivor"])
    );
    expect(report.maintenanceFindings.find((finding) => finding.kind === "generic_selector")).toMatchObject({
      contractId: "safe-contract",
      recommendedAction: "add_assertion",
      hiveOwner: "quality"
    });
    expect(report.maintenanceFindings.every((finding) => finding.validationCommand.startsWith("visual-hive "))).toBe(true);
    expect(report.recommendations.map((recommendation) => recommendation.kind)).toContain("map_mutation_operator");
    expect(report.recommendations.map((recommendation) => recommendation.kind)).toContain("add_changed_file_rule");
    expect(report.recommendations.map((recommendation) => recommendation.kind)).toContain("maintain_visual_test");
    expect(report.recommendations.find((recommendation) => recommendation.kind === "map_mutation_operator")?.suggestedConfigYaml).toContain(
      "hide-critical-button"
    );
    const maintenanceRecommendation = report.recommendations.find((recommendation) => recommendation.kind === "maintain_visual_test");
    expect(maintenanceRecommendation).toMatchObject({
      maintenanceFindingId: expect.any(String),
      contractId: expect.any(String)
    });
    expect(report.recommendations.find((recommendation) => recommendation.id === "changed-file-rule:scripts/build.js")?.suggestedConfigYaml).toContain(
      "scripts/**"
    );
  });

  it("does not apply visual test maintenance recommendations automatically", () => {
    const config = sampleConfig();
    const coverage = analyzeCoverage(config, { changedFiles: [], now: new Date("2026-06-15T00:00:00.000Z") });
    const report = buildCoverageImprovementReport(config, coverage, undefined, { now: new Date("2026-06-15T00:02:00.000Z") });
    const recommendation = report.recommendations.find((candidate) => candidate.kind === "maintain_visual_test");

    expect(recommendation).toBeDefined();
    const result = applyCoverageImprovementRecommendation(config, report, recommendation!.id);
    expect(result.applied).toBe(false);
    expect(result.diff).toBe("No config changes.");
  });

  it("adds data-driven visual-test maintenance findings from baseline artifacts", () => {
    const config = sampleConfig();
    const coverage = analyzeCoverage(config, { changedFiles: [], now: new Date("2026-06-15T00:00:00.000Z") });
    const report = buildCoverageImprovementReport(config, coverage, undefined, {
      now: new Date("2026-06-25T00:00:00.000Z"),
      baselineList: {
        schemaVersion: 1,
        project: "sample",
        generatedAt: "2026-06-15T00:00:00.000Z",
        reportGeneratedAt: "2026-06-15T00:00:00.000Z",
        reportPath: ".visual-hive/report.json",
        approvalLogPath: ".visual-hive/baseline-approvals.json",
        rejectionLogPath: ".visual-hive/baseline-rejections.json",
        summary: {
          total: 1,
          passed: 0,
          failed: 1,
          created: 0,
          missingBaseline: 0,
          approvable: 1,
          approved: 0,
          rejected: 0,
          pendingReview: 1
        },
        entries: [
          {
            contractId: "safe-contract",
            screenshotName: "home",
            route: "/",
            viewport: "desktop",
            status: "failed",
            baselinePath: ".visual-hive/snapshots/home.png",
            actualPath: ".visual-hive/artifacts/screenshots/home.png",
            maxDiffPixelRatio: 0.01,
            actualDiffPixelRatio: 0.2,
            actualDiffPixels: 100,
            canApprove: true,
            canReject: true
          }
        ]
      },
      baselineApprovals: {
        schemaVersion: 1,
        approvals: [
          {
            schemaVersion: 1,
            approvedAt: "2026-06-14T00:00:00.000Z",
            contractId: "safe-contract",
            screenshotName: "home",
            route: "/",
            viewport: "desktop",
            sourceStatus: "failed",
            actualPath: ".visual-hive/artifacts/screenshots/home-a.png",
            baselinePath: ".visual-hive/snapshots/home.png",
            bytes: 100
          },
          {
            schemaVersion: 1,
            approvedAt: "2026-06-15T00:00:00.000Z",
            contractId: "safe-contract",
            screenshotName: "home",
            route: "/",
            viewport: "desktop",
            sourceStatus: "failed",
            actualPath: ".visual-hive/artifacts/screenshots/home-b.png",
            baselinePath: ".visual-hive/snapshots/home.png",
            bytes: 101
          }
        ]
      },
      baselineRejections: {
        schemaVersion: 1,
        rejections: [
          {
            schemaVersion: 1,
            rejectedAt: "2026-06-16T00:00:00.000Z",
            contractId: "safe-contract",
            screenshotName: "home",
            route: "/",
            viewport: "desktop",
            sourceStatus: "failed",
            actualPath: ".visual-hive/artifacts/screenshots/home-c.png",
            baselinePath: ".visual-hive/snapshots/home.png",
            reason: "unstable visual"
          }
        ]
      }
    });

    expect(report.maintenanceFindings.map((finding) => finding.kind)).toEqual(expect.arrayContaining(["stale_baseline", "baseline_churn"]));
    expect(report.recommendations.find((recommendation) => recommendation.maintenanceFindingId?.includes("stale-baseline"))?.suggestedTests.join(" ")).toContain(
      "Review or reject the pending baseline change"
    );
    expect(report.recommendations.find((recommendation) => recommendation.maintenanceFindingId?.includes("baseline-churn"))?.suggestedConfigYaml).toContain(
      "dynamic-region"
    );
  });

  it("applies a selected coverage improvement recommendation as a validated config diff", () => {
    const config = sampleConfig();
    const plan = createPlan(config, { mode: "pr", changedFiles: ["scripts/build.js"] });
    const coverage = analyzeCoverage(config, { plan, changedFiles: ["scripts/build.js"], now: new Date("2026-06-15T00:00:00.000Z") });
    const report = buildCoverageImprovementReport(config, coverage, undefined, { now: new Date("2026-06-15T00:02:00.000Z") });
    const result = applyCoverageImprovementRecommendation(config, report, "changed-file-rule:scripts/build.js");
    const parsed = parseConfigText(result.configText);

    expect(result.applied).toBe(true);
    expect(result.diff).toContain("+    - pattern: scripts/**");
    expect(parsed.selection.changedFiles.map((rule) => rule.pattern)).toContain("scripts/**");
    expect(parsed.selection.changedFiles.find((rule) => rule.pattern === "scripts/**")?.contracts.length).toBeGreaterThan(0);
  });

  it("applies mutation survivor recommendations by mapping the operator and adding suggested assertions", () => {
    const config = sampleConfig();
    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"] });
    const coverage = analyzeCoverage(config, { plan, changedFiles: ["src/App.tsx"], now: new Date("2026-06-15T00:00:00.000Z") });
    const report = buildCoverageImprovementReport(
      config,
      coverage,
      {
        schemaVersion: 2,
        project: "sample",
        generatedAt: "2026-06-15T00:01:00.000Z",
        minScore: 0.7,
        score: 0,
        killed: 0,
        total: 1,
        results: [
          {
            operator: "hide-critical-button",
            status: "survived",
            killed: false,
            contractIds: ["safe-contract"],
            applicable: true,
            expectedFailureKinds: ["missing_element"],
            durationMs: 25,
            errors: ["critical button remained uncovered"]
          }
        ]
      },
      { now: new Date("2026-06-15T00:02:00.000Z") }
    );
    const result = applyCoverageImprovementRecommendation(config, report, "mutation-survivor:hide-critical-button:safe-contract");
    const parsed = parseConfigText(result.configText);
    const mappedOperator = parsed.mutation.operators.find((operator) =>
      typeof operator === "string" ? false : operator.id === "hide-critical-button"
    );

    expect(result.applied).toBe(true);
    expect(result.diff).toContain("id: hide-critical-button");
    expect(mappedOperator).toMatchObject({ id: "hide-critical-button", contracts: ["safe-contract"] });
    expect(parsed.contracts.find((contract) => contract.id === "safe-contract")?.selectors.mustExist).toContain(
      "[data-testid='critical-action-button']"
    );
  });

  it("builds and applies flow-step coverage recommendations from flow gaps", () => {
    const config = sampleConfig();
    const flowAudit = auditFlows(config, { selectedContractIds: ["safe-contract"], now: new Date("2026-06-15T00:01:00.000Z") });
    const coverage = analyzeCoverage(config, { changedFiles: [], now: new Date("2026-06-15T00:00:00.000Z") });
    const report = buildCoverageImprovementReport(config, coverage, undefined, {
      now: new Date("2026-06-15T00:02:00.000Z"),
      flowAudit
    });
    const flowRecommendation = report.recommendations.find((recommendation) => recommendation.id === "flow-steps:safe-contract");
    const result = applyCoverageImprovementRecommendation(config, report, "flow-steps:safe-contract");
    const parsed = parseConfigText(result.configText);
    const steps = parsed.contracts.find((contract) => contract.id === "safe-contract")?.steps ?? [];

    expect(report.summary.fromFlowGaps).toBeGreaterThan(0);
    expect(flowRecommendation).toMatchObject({ contractId: "safe-contract", route: "/" });
    expect(flowRecommendation).toMatchObject({ lane: "pull_request", trustedOnly: false });
    expect(result.applied).toBe(true);
    expect(steps.map((step) => step.action)).toEqual(expect.arrayContaining(["goto", "assertVisible"]));
    expect(steps.find((step) => step.action === "assertVisible")?.selector).toBe("main");
  });

  it("marks protected flow recommendations as trusted-only", () => {
    const config = sampleConfig();
    const flowAudit = auditFlows(config, { selectedContractIds: ["safe-contract"], now: new Date("2026-06-15T00:01:00.000Z") });
    const coverage = analyzeCoverage(config, { changedFiles: [], now: new Date("2026-06-15T00:00:00.000Z") });
    const report = buildCoverageImprovementReport(config, coverage, undefined, { flowAudit });
    const protectedRecommendation = report.recommendations.find((recommendation) => recommendation.id === "flow-steps:unsafe-contract");

    expect(protectedRecommendation).toMatchObject({
      contractId: "unsafe-contract",
      lane: "protected",
      trustedOnly: true
    });
    expect(protectedRecommendation?.suggestedTests.join(" ")).toContain("trusted scheduled/manual lane");
  });
});

describe("risk register", () => {
  it("prioritizes deterministic, baseline, mutation, coverage, flow, target, workflow, and provider risks", () => {
    const config = sampleConfig();
    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"] });
    const report: Report = {
      schemaVersion: 2,
      project: "sample",
      repository: sampleRepository,
      mode: "pr",
      generatedAt: "2026-06-15T00:00:00.000Z",
      status: "failed",
      changedFiles: ["src/App.tsx"],
      selectedTargets: [{ id: "safe", kind: "url", url: "https://safe.example.com", prSafe: true, cost: "cheap" }],
      selectedContracts: ["safe-contract", "changed-contract"],
      excludedContracts: [],
      targetLifecycle: [],
      generatedSpecPath: ".visual-hive/generated/visual-hive.generated.spec.ts",
      results: [
        {
          contractId: "safe-contract",
          targetId: "safe",
          status: "failed",
          durationMs: 12,
          errors: ["mustExist main failed with token=secret-value"],
          artifacts: [".visual-hive/artifacts/results/safe-contract.json"],
          selectorAssertions: [{ kind: "mustExist", value: "main", status: "failed" }],
          screenshotAssertions: [
            {
              contractId: "safe-contract",
              screenshotName: "home",
              name: "home",
              route: "/",
              viewport: "desktop",
              status: "missing_baseline",
              baselinePath: ".visual-hive/snapshots/home.png",
              actualPath: ".visual-hive/artifacts/screenshots/home.png",
              maxDiffPixelRatio: 0.01,
              totalPixels: 100
            }
          ],
          consoleErrors: [],
          pageErrors: [],
          networkErrors: [],
          reproductionCommand: "visual-hive run --ci"
        }
      ],
      summary: {
        passed: 0,
        failed: 1,
        screenshotsPassed: 0,
        screenshotsFailed: 1,
        baselinesCreated: 0,
        createdBaselines: 0,
        missingBaselines: 1,
        visualDiffs: 0,
        consoleErrors: 0,
        pageErrors: 0
      },
      consoleErrors: [],
      pageErrors: [],
      artifacts: [],
      providerResults: [
        {
          providerId: "argos",
          label: "Argos",
          status: "missing_credentials",
          deterministicRole: "supplemental",
          message: "Missing ARGOS_TOKEN",
          requiredEnv: ["ARGOS_TOKEN"],
          missingEnv: ["ARGOS_TOKEN"],
          artifactCount: 0,
          normalizedAt: "2026-06-15T00:00:00.000Z"
        }
      ],
      reproductionCommands: ["visual-hive run --ci"]
    };
    const coverage = analyzeCoverage(config, { plan });
    const targets = auditTargets(config, { plan, report, env: {} });
    const workflows = auditWorkflows(config, [
      {
        path: ".github/workflows/visual-hive-pr.yml",
        content: "on: pull_request_target\npermissions:\n  contents: write\njobs:\n  test:\n    steps:\n      - run: echo broken"
      }
    ]);
    const risk = analyzeRisk(config, {
      plan,
      report,
      mutationReport: {
        schemaVersion: 2,
        project: "sample",
        generatedAt: "2026-06-15T00:00:00.000Z",
        minScore: 0.7,
        score: 0.5,
        killed: 1,
        total: 2,
        results: [
          {
            operator: "force-login-on-demo",
            status: "survived",
            killed: false,
            applicable: true,
            contractIds: ["safe-contract"],
            expectedFailureKinds: ["login_regression"],
            durationMs: 5,
            errors: [],
            artifacts: [".visual-hive/mutation-report.json"]
          }
        ]
      },
      coverageReport: coverage,
      flowAudit: auditFlows(config, { plan, report }),
      targetAudit: targets,
      workflowAudit: workflows,
      providerDecisions: {
        schemaVersion: 1,
        generatedAt: "2026-06-15T00:00:00.000Z",
        decisions: [
          {
            providerId: "argos",
            label: "Argos",
            decision: "skip",
            reason: "Use local Playwright artifacts for now.",
            decidedAt: "2026-06-15T00:00:00.000Z",
            source: "cli",
            externalCallsMade: 0
          }
        ]
      },
      llmDecisions: {
        schemaVersion: 1,
        generatedAt: "2026-06-15T00:00:00.000Z",
        decisions: [
          {
            decision: "keep_disabled",
            reason: "No model calls from PR lanes.",
            decidedAt: "2026-06-15T00:00:00.000Z",
            source: "cli",
            externalCallsMade: 0
          }
        ]
      },
      now: new Date("2026-06-15T00:00:00.000Z")
    });

    expect(risk.schemaVersion).toBe(1);
    expect(risk.summary.total).toBeGreaterThan(0);
    expect(risk.summary.prBlocking).toBeGreaterThan(0);
    expect(risk.inputs.flowAudit).toBe(true);
    expect(risk.inputs.providerDecisions).toBe(true);
    expect(risk.inputs.llmDecisions).toBe(true);
    expect(risk.risks.map((item) => item.category)).toEqual(
      expect.arrayContaining([
        "deterministic_failure",
        "baseline_review",
        "mutation_adequacy",
        "flow_coverage",
        "target_safety",
        "workflow_safety",
        "provider_policy",
        "llm_governance"
      ])
    );
    expect(risk.risks.find((item) => item.id === "provider-decision:argos")).toMatchObject({
      category: "provider_policy",
      trustedOnly: true
    });
    expect(risk.risks.find((item) => item.category === "deterministic_failure")?.message).toContain("[REDACTED]");
    expect(risk.risks.find((item) => item.id === "llm-decision:latest")).toMatchObject({
      category: "llm_governance",
      trustedOnly: true
    });
    expect(risk.recommendations).toContain("Fix deterministic contract failures before updating baselines.");
    expect(risk.recommendations).toContain("Add or repair deterministic flow steps for high-risk user journeys.");
    expect(risk.recommendations).toContain("Repair critical/high GitHub workflow safety findings before relying on CI automation.");
  });

  it("reports tag-pinned action workflow risk as production hardening only", () => {
    const workflows = auditWorkflows(sampleConfig(), [
      {
        path: ".github/workflows/visual-hive-pr.yml",
        content: `
on: pull_request
permissions:
  contents: read
jobs:
  visual-hive:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-artifact@v4
        with:
          include-hidden-files: true
      - run: visual-hive baselines list --write
`
      }
    ]);
    const risk = analyzeRisk(sampleConfig(), { workflowAudit: workflows, now: new Date("2026-06-15T00:00:00.000Z") });

    expect(risk.summary.prBlocking).toBe(0);
    expect(risk.risks.find((item) => item.id.includes("action_not_sha_pinned"))).toMatchObject({
      category: "workflow_safety",
      severity: "low",
      prBlocking: false
    });
    expect(risk.recommendations).toContain(
      "For production hardening, pin external GitHub Actions by full commit SHA after reviewing upstream source."
    );
    expect(risk.recommendations.join(" ")).not.toContain("Repair critical/high GitHub workflow safety findings");
  });

  it("flags enabled external providers without matching setup plans or handoff manifests", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "provider-risk", type: "custom", defaultBranch: "main" },
      targets: { local: { kind: "url", url: "http://127.0.0.1:4173" } },
      contracts: [{ id: "dashboard", description: "Dashboard", target: "local", runOn: { pullRequest: true } }],
      providers: {
        argos: {
          enabled: true,
          mode: "external",
          requiredEnv: ["ARGOS_TOKEN"]
        }
      },
      costPolicy: {
        maxExternalScreenshotsPerRun: 10,
        maxMonthlyExternalScreenshots: 1000,
        externalUpload: {
          pullRequest: false,
          schedule: true,
          manual: true,
          canary: false,
          mutation: false,
          full: true,
          onFailureOnly: false,
          criticalContractsOnly: false
        }
      }
    });
    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"] });

    const missingPlanRisk = analyzeRisk(config, { plan, now: new Date("2026-06-15T00:00:00.000Z") });
    expect(missingPlanRisk.inputs.providerSetupPlan).toBe(false);
    expect(missingPlanRisk.inputs.providerHandoff).toBe(false);
    expect(missingPlanRisk.risks.find((item) => item.id === "provider-setup-plan:missing:argos")).toMatchObject({
      category: "provider_policy",
      severity: "medium",
      trustedOnly: true
    });
    expect(missingPlanRisk.risks.find((item) => item.id === "provider-handoff:missing:argos")).toMatchObject({
      category: "provider_policy",
      severity: "medium",
      trustedOnly: true
    });

    const setupPlan = buildProviderSetupPlan(config, { providerId: "argos", env: {}, generatedAt: "2026-06-15T00:00:00.000Z" });
    const handoff = buildProviderHandoffManifest(
      config,
      reportFixture(repoRoot, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"),
      { providerId: "argos", env: { ARGOS_TOKEN: "secret-value" }, generatedAt: "2026-06-15T00:00:00.000Z" }
    );
    const withPlanRisk = analyzeRisk(config, { plan, providerSetupPlan: setupPlan, providerHandoff: handoff, now: new Date("2026-06-15T00:00:00.000Z") });
    expect(withPlanRisk.inputs.providerSetupPlan).toBe(true);
    expect(withPlanRisk.inputs.providerHandoff).toBe(true);
    expect(withPlanRisk.risks.find((item) => item.id === "provider-setup-plan:argos")).toMatchObject({
      title: "Provider setup is blocked: Argos",
      category: "provider_policy",
      severity: "medium",
      trustedOnly: true
    });
    expect(withPlanRisk.risks.find((item) => item.id === "provider-handoff:argos")).toMatchObject({
      title: "Provider handoff recorded: Argos",
      category: "provider_policy",
      severity: "low",
      trustedOnly: true
    });
    expect(withPlanRisk.risks.find((item) => item.id === "provider-setup-plan:missing:argos")).toBeUndefined();
    expect(withPlanRisk.risks.find((item) => item.id === "provider-handoff:missing:argos")).toBeUndefined();
    expect(JSON.stringify(withPlanRisk)).not.toContain("secret-value");
  });

  it("turns regressed run history into actionable risk evidence", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-risk-history-"));
    tempDirs.push(tempRoot);
    const previousReport = reportFixture(tempRoot, path.join(tempRoot, ".visual-hive", "artifacts", "previous.png"), path.join(tempRoot, ".visual-hive", "snapshots", "baseline.png"));
    previousReport.status = "passed";
    previousReport.summary.failed = 0;
    previousReport.summary.visualDiffs = 0;
    previousReport.results[0]!.status = "passed";
    previousReport.results[0]!.errors = [];
    const latestReport = reportFixture(tempRoot, path.join(tempRoot, ".visual-hive", "artifacts", "latest.png"), path.join(tempRoot, ".visual-hive", "snapshots", "baseline.png"));
    const runHistory = createRunHistoryReport({
      project: "sample",
      generatedAt: "2026-06-15T01:01:00.000Z",
      entries: [
        createRunHistoryEntry({
          repoRoot: tempRoot,
          id: "previous",
          recordedAt: "2026-06-15T00:00:00.000Z",
          files: { report: ".visual-hive/history/previous/report.json" },
          report: previousReport
        }),
        createRunHistoryEntry({
          repoRoot: tempRoot,
          id: "latest",
          recordedAt: "2026-06-15T01:00:00.000Z",
          files: { report: ".visual-hive/history/latest/report.json" },
          report: latestReport
        })
      ]
    });

    const risk = analyzeRisk(sampleConfig(), { runHistory, now: new Date("2026-06-15T01:02:00.000Z") });

    expect(risk.inputs.runHistory).toBe(true);
    expect(risk.risks.find((item) => item.category === "history_regression")).toMatchObject({
      id: "history:latest-run-regressed",
      severity: "high",
      prBlocking: true
    });
    expect(risk.recommendations).toContain("Compare latest and previous run history before accepting the current visual QA state.");
  });
});

describe("contract audit", () => {
  it("reports contract gaps, latest status, changed-file rules, and mutation mappings", () => {
    const config = sampleConfig();
    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"] });
    const audit = auditContracts(config, {
      plan,
      report: {
        schemaVersion: 2,
        project: "sample",
        repository: sampleRepository,
        mode: "pr",
        generatedAt: "2026-06-15T00:00:00.000Z",
        status: "failed",
        changedFiles: ["src/App.tsx"],
        selectedTargets: [],
        selectedContracts: ["safe-contract", "changed-contract"],
        excludedContracts: [],
        targetLifecycle: [],
        generatedSpecPath: ".visual-hive/generated/visual-hive.generated.spec.ts",
        results: [
          {
            contractId: "safe-contract",
            targetId: "safe",
            status: "failed",
            durationMs: 5,
            errors: ["selector failed"],
            artifacts: [],
            consoleErrors: [],
            pageErrors: [],
            networkErrors: [],
            reproductionCommand: "visual-hive run --ci"
          }
        ],
        summary: {
          passed: 0,
          failed: 1,
          screenshotsPassed: 0,
          screenshotsFailed: 0,
          baselinesCreated: 0,
          createdBaselines: 0,
          missingBaselines: 0,
          visualDiffs: 0,
          consoleErrors: 0,
          pageErrors: 0
        },
        consoleErrors: [],
        pageErrors: [],
        artifacts: [],
        reproductionCommands: []
      }
    });

    expect(audit.schemaVersion).toBe(1);
    expect(audit.summary.contractCount).toBe(3);
    expect(audit.summary.failedContracts).toBe(1);
    expect(audit.summary.mutationMappedContracts).toBe(0);
    const safe = audit.contracts.find((contract) => contract.id === "safe-contract");
    expect(safe?.latestStatus).toBe("failed");
    expect(safe?.gaps.map((gap) => gap.kind)).toContain("failed_latest_run");
    const changed = audit.contracts.find((contract) => contract.id === "changed-contract");
    expect(changed?.changedFileRules[0]?.pattern).toBe("src/**");
    const unsafe = audit.contracts.find((contract) => contract.id === "unsafe-contract");
    expect(unsafe?.gaps.map((gap) => gap.kind)).toContain("pr_unsafe_target");
  });
});

describe("flow audit", () => {
  it("reports user-flow coverage, latest flow failures, and critical gaps", () => {
    const base = sampleConfig();
    const config = VisualHiveConfigSchema.parse({
      ...base,
      contracts: base.contracts.map((contract) =>
        contract.id === "safe-contract"
          ? {
              ...contract,
              steps: [
                { action: "goto", route: "/" },
                { action: "click", selector: "[data-testid='critical-action-button']" },
                { action: "assertText", selector: "main", text: "Ready" }
              ]
            }
          : contract
      )
    });
    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"], allowUnsafeTargets: true });
    const report: Report = {
      schemaVersion: 2,
      project: "sample",
      repository: sampleRepository,
      mode: "pr",
      generatedAt: "2026-06-15T00:00:00.000Z",
      status: "failed",
      changedFiles: ["src/App.tsx"],
      selectedTargets: [],
      selectedContracts: ["safe-contract"],
      excludedContracts: [],
      targetLifecycle: [],
      generatedSpecPath: ".visual-hive/generated/visual-hive.generated.spec.ts",
      results: [
        {
          contractId: "safe-contract",
          targetId: "safe",
          status: "failed",
          durationMs: 10,
          errors: ["flow failed"],
          artifacts: [],
          flowSteps: [
            { action: "goto", route: "/", status: "passed", durationMs: 1 },
            {
              action: "click",
              selector: "[data-testid='critical-action-button']",
              status: "failed",
              durationMs: 2,
              message: "button was disabled"
            }
          ],
          reproductionCommand: "visual-hive run --ci"
        }
      ],
      summary: {
        passed: 0,
        failed: 1,
        screenshotsPassed: 0,
        screenshotsFailed: 0,
        baselinesCreated: 0,
        createdBaselines: 0,
        missingBaselines: 0,
        visualDiffs: 0,
        consoleErrors: 0,
        pageErrors: 0,
        flowStepsPassed: 1,
        flowStepsFailed: 1
      },
      consoleErrors: [],
      pageErrors: [],
      artifacts: [],
      reproductionCommands: []
    };

    const audit = auditFlows(config, { plan, report, now: new Date("2026-06-15T00:00:00.000Z") });

    expect(audit.schemaVersion).toBe(1);
    expect(audit.summary).toMatchObject({
      contractCount: 3,
      flowContractCount: 1,
      flowStepCount: 3,
      navigationSteps: 1,
      interactionSteps: 1,
      assertionSteps: 1,
      failedFlowSteps: 1,
      criticalContractsWithoutFlow: 1
    });
    const safe = audit.flows.find((flow) => flow.contractId === "safe-contract");
    expect(safe?.steps.map((step) => step.category)).toEqual(["navigation", "interaction", "assertion"]);
    expect(safe?.gaps.map((gap) => gap.kind)).toContain("failed_latest_flow");
    expect(safe?.latestFailedMessages).toContain("button was disabled");
    const unsafe = audit.flows.find((flow) => flow.contractId === "unsafe-contract");
    expect(unsafe?.gaps.map((gap) => gap.kind)).toContain("no_flow_steps");
    expect(audit.recommendations.join(" ")).toContain("critical contracts");
  });
});

describe("target audit", () => {
  it("reports target safety, services, missing secret names, lifecycle, and gaps", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "targets", type: "custom", defaultBranch: "main" },
      targets: {
        preview: {
          kind: "command",
          serve: "npm run preview -- --token=abc",
          url: "http://127.0.0.1:4173",
          prSafe: true,
          cost: "cheap"
        },
        fullstack: {
          kind: "commandGroup",
          url: "http://127.0.0.1:4177",
          prSafe: true,
          cost: "medium",
          services: [{ name: "api", command: "npm run api -- --secret=abc", url: "http://127.0.0.1:8080/health" }]
        },
        live: {
          kind: "protected",
          url: "https://prod.example.com",
          cost: "expensive",
          requiresSecrets: ["KUBECONFIG", "KC_AGENT_TOKEN"]
        }
      },
      contracts: [
        {
          id: "preview-contract",
          description: "Preview",
          target: "preview",
          runOn: { pullRequest: true },
          selectors: { mustExist: ["main"] }
        },
        {
          id: "live-contract",
          description: "Live",
          target: "live",
          runOn: { pullRequest: true, schedule: true },
          selectors: { mustExist: ["main"] }
        }
      ]
    });
    const plan = createPlan(config, { mode: "pr", changedFiles: [] });
    const audit = auditTargets(config, {
      plan,
      env: {},
      now: new Date("2026-06-15T00:00:00.000Z"),
      report: {
        schemaVersion: 2,
        project: "targets",
        repository: sampleRepository,
        mode: "pr",
        generatedAt: "2026-06-15T00:00:00.000Z",
        status: "failed",
        changedFiles: [],
        selectedTargets: [],
        selectedContracts: ["preview-contract"],
        excludedContracts: [],
        targetLifecycle: [
          {
            targetId: "preview",
            phase: "serve",
            status: "failed",
            durationMs: 10,
            command: "npm run preview -- --token=abc",
            url: "http://127.0.0.1:4173",
            message: "token=abc failed"
          }
        ],
        generatedSpecPath: ".visual-hive/generated/visual-hive.generated.spec.ts",
        results: [],
        summary: {
          passed: 0,
          failed: 0,
          screenshotsPassed: 0,
          screenshotsFailed: 0,
          baselinesCreated: 0,
          createdBaselines: 0,
          missingBaselines: 0,
          visualDiffs: 0,
          consoleErrors: 0,
          pageErrors: 0
        },
        consoleErrors: [],
        pageErrors: [],
        artifacts: [],
        reproductionCommands: []
      }
    });

    expect(audit.summary.targetCount).toBe(3);
    expect(audit.summary.protectedTargets).toBe(1);
    expect(audit.summary.missingSecretNames).toBe(2);
    expect(audit.summary.targetsWithFailedLifecycle).toBe(1);
    expect(audit.targets.find((target) => target.id === "preview")?.lifecycleEvents[0]?.command).toContain("[REDACTED]");
    expect(audit.targets.find((target) => target.id === "fullstack")?.gaps.map((gap) => gap.kind)).toContain("target_without_contracts");
    const live = audit.targets.find((target) => target.id === "live");
    expect(live?.labels).toEqual(expect.arrayContaining(["Protected", "Expensive"]));
    expect(live?.missingSecrets).toEqual(["KUBECONFIG", "KC_AGENT_TOKEN"]);
    expect(live?.gaps.map((gap) => gap.kind)).toContain("pr_contract_on_unsafe_target");
  });

  it("reports deploy preview target URL readiness by env name only", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "deploy-targets", type: "custom", defaultBranch: "main" },
      targets: {
        preview: {
          kind: "deployPreview",
          provider: "vercel",
          urlEnv: "VERCEL_URL"
        }
      },
      contracts: [
        {
          id: "preview-pr",
          description: "Preview PR",
          target: "preview",
          runOn: { pullRequest: true }
        }
      ]
    });

    const missing = auditTargets(config, { env: {}, now: new Date("2026-06-15T00:00:00.000Z") });
    expect(missing.summary.deployPreviewTargets).toBe(1);
    expect(missing.targets[0]?.url).toBe("");
    expect(missing.targets[0]?.gaps.map((gap) => gap.kind)).toContain("deploy_preview_url_unresolved");
    expect(JSON.stringify(missing)).toContain("VERCEL_URL");

    const ready = auditTargets(config, {
      env: { VERCEL_URL: "secret-preview-host.vercel.app" },
      now: new Date("2026-06-15T00:00:00.000Z")
    });
    expect(ready.targets[0]).toMatchObject({
      kind: "deployPreview",
      url: "https://secret-preview-host.vercel.app",
      prSafe: true,
      cost: "cheap"
    });
    expect(ready.targets[0]?.gaps.map((gap) => gap.kind)).not.toContain("deploy_preview_url_unresolved");
  });

  it("validates, plans, and audits storybook targets as PR-safe component lanes", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "storybook-targets", type: "custom", defaultBranch: "main", setupProfile: "component-storybook" },
      targets: {
        componentLibrary: {
          kind: "storybook",
          install: "npm ci",
          build: "npm run build-storybook",
          serve: "npm run storybook -- --host 127.0.0.1 --port 6006",
          url: "http://127.0.0.1:6006",
          stories: ["src/**/*.stories.tsx"],
          components: ["src/components/**"]
        }
      },
      contracts: [
        {
          id: "storybook-button",
          description: "Button story remains stable",
          target: "componentLibrary",
          severity: "medium",
          runOn: { pullRequest: true },
          screenshots: [{ name: "button-primary", route: "/?path=/story/button--primary", viewport: "desktop" }]
        }
      ],
      selection: {
        changedFiles: [{ pattern: "src/components/**", contracts: ["storybook-button"], risk: "medium" }]
      }
    });

    expect(config.targets.componentLibrary).toMatchObject({
      kind: "storybook",
      prSafe: true,
      cost: "cheap"
    });

    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/components/Button.tsx"] });
    expect(plan.targets[0]).toMatchObject({ id: "componentLibrary", kind: "storybook", url: "http://127.0.0.1:6006" });
    expect(plan.items.map((item) => item.contractId)).toEqual(["storybook-button"]);

    const audit = auditTargets(config, { plan, now: new Date("2026-06-15T00:00:00.000Z") });
    expect(audit.summary.storybookTargets).toBe(1);
    expect(audit.summary.setupRequiredTargets).toBe(1);
    expect(audit.targets[0]?.labels).toEqual(expect.arrayContaining(["Safe on PR", "Needs setup"]));
    expect(audit.targets[0]?.commands).toMatchObject({
      build: "npm run build-storybook",
      serve: "npm run storybook -- --host 127.0.0.1 --port 6006"
    });
    expect(audit.targets[0]?.gaps.map((gap) => gap.kind)).not.toContain("storybook_without_component_scope");
  });

  it("flags storybook targets without declared story or component scope", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "storybook-scope", type: "custom", defaultBranch: "main" },
      targets: {
        componentLibrary: {
          kind: "storybook",
          url: "http://127.0.0.1:6006"
        }
      },
      contracts: [
        {
          id: "storybook-smoke",
          description: "Storybook smoke",
          target: "componentLibrary",
          runOn: { pullRequest: true }
        }
      ]
    });

    const audit = auditTargets(config, { now: new Date("2026-06-15T00:00:00.000Z") });
    expect(audit.targets[0]?.gaps.map((gap) => gap.kind)).toContain("storybook_without_component_scope");
    expect(audit.targets[0]?.recommendations.join(" ")).toContain("component globs");
  });
});

describe("schedule audit", () => {
  it("models PR, scheduled, protected, mutation, and trusted issue lanes without secret values", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "schedules", type: "custom", defaultBranch: "main" },
      targets: {
        preview: {
          kind: "url",
          url: "http://127.0.0.1:4173",
          prSafe: true,
          cost: "cheap"
        },
        live: {
          kind: "protected",
          url: "https://prod.example.com",
          schedule: "0 6 * * *",
          requiresSecrets: ["LIVE_TOKEN", "KC_AGENT_TOKEN"],
          cost: "expensive"
        }
      },
      contracts: [
        {
          id: "preview-pr",
          description: "Preview PR",
          target: "preview",
          runOn: { pullRequest: true, schedule: true },
          selectors: { mustExist: ["main"] }
        },
        {
          id: "live-scheduled",
          description: "Live scheduled",
          target: "live",
          runOn: { schedule: true },
          selectors: { mustExist: ["main"] }
        }
      ],
      mutation: {
        enabled: true,
        runOn: { schedule: true },
        minScore: 0.7,
        operators: ["hide-critical-button"]
      }
    });

    const audit = auditSchedules(config, {
      env: { LIVE_TOKEN: "super-secret-value" },
      now: new Date("2026-06-15T00:00:00.000Z"),
      changedFiles: ["src/App.tsx"]
    });

    expect(audit.schemaVersion).toBe(1);
    expect(audit.summary).toMatchObject({
      pullRequestContracts: 1,
      scheduledContracts: 2,
      protectedContracts: 1,
      protectedScheduledContracts: 1,
      mutationScheduled: true,
      missingSecretNames: 1
    });
    expect(audit.lanes.map((lane) => lane.id)).toEqual(["pull_request", "scheduled", "protected", "mutation", "trusted_issue"]);
    expect(audit.lanes.find((lane) => lane.id === "pull_request")?.usesSecrets).toBe(false);
    expect(audit.lanes.find((lane) => lane.id === "protected")?.requiresSecrets).toEqual(["KC_AGENT_TOKEN", "LIVE_TOKEN"]);
    expect(audit.lanes.find((lane) => lane.id === "protected")?.missingSecrets).toEqual(["KC_AGENT_TOKEN"]);
    expect(JSON.stringify(audit)).not.toContain("super-secret-value");
    expect(audit.recommendations).toContain("Keep PR workflows read-only and secret-free.");
  });
});

describe("workflow safety audit", () => {
  it("flags unsafe PR workflow patterns and validates trusted issue workflows", () => {
    const audit = auditWorkflows(
      sampleConfig(),
      [
        {
          path: ".github/workflows/unsafe-pr.yml",
          content: `name: Unsafe PR
on:
  pull_request_target:
permissions:
  contents: write
  issues: write
jobs:
  visual-hive:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx visual-hive plan --mode pr
        env:
          TOKEN: \${{ secrets.PR_TOKEN }}
      - uses: actions/github-script@v7
        with:
          script: github.rest.issues.create({})
`
        },
        {
          path: ".github/workflows/visual-hive-failure-issue.yml",
          content: `name: Visual Hive failure issue
on:
  workflow_run:
    workflows: ["Visual Hive PR"]
permissions:
  contents: read
  actions: read
  issues: write
jobs:
  issue:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - uses: actions/github-script@v7
        with:
          script: |
            const marker = "<!-- visual-hive-dedupe:" + context.runId + " -->";
            await github.rest.issues.create({ body: marker });
`
        }
      ],
      { workflowRoot: ".github/workflows", now: new Date("2026-06-15T00:00:00.000Z") }
    );

    expect(audit.schemaVersion).toBe(1);
    expect(audit.summary.workflowCount).toBe(2);
    expect(audit.summary.workflowsUsingPullRequestTarget).toBe(1);
    expect(audit.summary.prWorkflowsUsingSecrets).toBe(1);
    expect(audit.summary.prWorkflowsWithWritePermissions).toBe(1);
    expect(audit.summary.trustedIssueWorkflows).toBe(1);
    expect(audit.findings.map((finding) => finding.kind)).toEqual(
      expect.arrayContaining([
        "pull_request_target_execution",
        "pr_uses_secrets",
        "pr_write_permissions",
        "pr_creates_issues",
        "missing_issue_artifact",
        "missing_trusted_issue_redaction"
      ])
    );
    const trusted = audit.workflows.find((workflow) => workflow.kind === "trusted_issue");
    expect(trusted?.checksOutCode).toBe(false);
    expect(trusted?.readsIssueArtifact).toBe(false);
  });

  it("recognizes a safe Visual Hive PR workflow", () => {
    const audit = auditWorkflows(sampleConfig(), [
      {
        path: ".github/workflows/visual-hive-pr.yml",
        content: `name: Visual Hive PR
on:
  pull_request:
permissions:
  contents: read
jobs:
  visual-hive:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx visual-hive plan --mode pr --ci
      - run: npx visual-hive run --ci
      - run: npx visual-hive baselines list --write
      - run: npx visual-hive triage
      - run: npx visual-hive report --github-step-summary
      - uses: actions/upload-artifact@v4
        with:
          name: visual-hive
          path: .visual-hive
          include-hidden-files: true
`
      }
    ]);

    expect(audit.summary.pullRequestWorkflows).toBe(1);
    expect(audit.summary.criticalFindings).toBe(0);
    expect(audit.summary.prWorkflowsUsingSecrets).toBe(0);
    expect(audit.summary.workflowsUsingUnpinnedActions).toBe(1);
    expect(audit.summary.unpinnedActionReferences).toBe(2);
    expect(audit.workflows[0]?.risk).toBe("low");
    expect(audit.workflows[0]?.writesBaselineReview).toBe(true);
    expect(audit.workflows[0]?.unpinnedActions.map((action) => action.value)).toEqual(["actions/checkout@v4", "actions/upload-artifact@v4"]);
    expect(audit.findings.find((finding) => finding.kind === "action_not_sha_pinned")?.severity).toBe("low");
  });

  it("treats SHA-pinned external actions and local actions as production-hardened", () => {
    const sha = "1234567890abcdef1234567890abcdef12345678";
    const audit = auditWorkflows(sampleConfig(), [
      {
        path: ".github/workflows/sha-pinned.yml",
        content: `name: SHA pinned
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  visual-hive:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${sha}
      - uses: ./.github/actions/local-setup
      - uses: docker://ghcr.io/example/action@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      - run: npx visual-hive report --github-step-summary
`
      }
    ]);

    expect(audit.summary.workflowsUsingUnpinnedActions).toBe(0);
    expect(audit.summary.unpinnedActionReferences).toBe(0);
    expect(audit.workflows[0]?.actions.map((action) => action.pinning)).toEqual(["sha", "local", "sha"]);
    expect(audit.findings.map((finding) => finding.kind)).not.toContain("action_not_sha_pinned");
  });

  it("warns when Visual Hive workflows upload artifacts without baseline review evidence", () => {
    const audit = auditWorkflows(sampleConfig(), [
      {
        path: ".github/workflows/visual-hive-pr.yml",
        content: `name: Visual Hive PR
on:
  pull_request:
permissions:
  contents: read
jobs:
  visual-hive:
    runs-on: ubuntu-latest
    steps:
      - run: npx visual-hive plan --mode pr --ci
      - run: npx visual-hive run --ci
      - run: npx visual-hive report --github-step-summary
      - uses: actions/upload-artifact@v4
        with:
          path: .visual-hive
          include-hidden-files: true
`
      }
    ]);

    expect(audit.workflows[0]?.writesBaselineReview).toBe(false);
    expect(audit.findings.map((finding) => finding.kind)).toContain("missing_baseline_review_artifact");
    expect(audit.findings.find((finding) => finding.kind === "missing_baseline_review_artifact")?.severity).toBe("low");
  });

  it("does not classify product-proof workflows as pull_request workflows by filename substring", () => {
    const audit = auditWorkflows(sampleConfig(), [
      {
        path: ".github/workflows/product-proof.yml",
        content: `name: Product Proof
on:
  workflow_dispatch:
  push:
    branches:
      - main
permissions:
  contents: read
jobs:
  proof:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run demo:full-run
      - uses: actions/upload-artifact@v4
        with:
          path: examples/demo-react-app/.visual-hive
          include-hidden-files: true
`
      }
    ]);

    expect(audit.workflows[0]?.kind).toBe("scheduled");
    expect(audit.summary.pullRequestWorkflows).toBe(0);
    expect(audit.summary.scheduledWorkflows).toBe(1);
    expect(audit.findings.map((finding) => finding.kind)).not.toContain("missing_pull_request_trigger");
  });

  it("recognizes a safe trusted issue workflow with recursive artifact discovery and redaction", () => {
    const audit = auditWorkflows(sampleConfig(), [
      {
        path: ".github/workflows/visual-hive-failure-issue.yml",
        content: `name: Visual Hive Failure Issue
on:
  workflow_run:
    workflows: ["Visual Hive PR"]
    types: [completed]
permissions:
  contents: read
  actions: read
  issues: write
jobs:
  create-issue:
    runs-on: ubuntu-latest
    if: vars.VISUAL_HIVE_AUTO_PUBLISH_ISSUES == 'true'
    steps:
      - uses: actions/download-artifact@1234567890abcdef1234567890abcdef12345678
        with:
          name: visual-hive
          path: visual-hive-artifacts
      - uses: actions/github-script@abcdef1234567890abcdef1234567890abcdef12
        with:
          script: |
            const fs = require("fs");
            function walkArtifacts(dir) {
              return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walkArtifacts(entry.name) : [entry.name]);
            }
            function findIssuesReport() {
              return walkArtifacts("visual-hive-artifacts").find((file) => file.endsWith("issues.json"));
            }
            function redactSecretValues(value) {
              return String(value)
                .replace(/client_secret=.*/gi, "client_secret=[REDACTED]")
                .replace(/authorization:.*/gi, "authorization: [REDACTED]")
                .replace(/set-cookie:.*/gi, "set-cookie: [REDACTED]")
                .replace(/Bearer .*/gi, "Bearer [REDACTED]");
            }
            const report = JSON.parse(redactSecretValues(fs.readFileSync(findIssuesReport(), "utf8")));
            const candidate = report.issues.find((issue) => issue.status === "open_candidate");
            const marker = "<!-- visual-hive-issue dedupe:" + candidate.dedupeFingerprint + " -->";
            await github.rest.issues.create({ body: marker + redactSecretValues(candidate.body) });
`
      }
    ]);

    const trusted = audit.workflows[0];
    expect(trusted?.kind).toBe("trusted_issue");
    expect(trusted?.permissions).toMatchObject({ contents: "read", actions: "read", issues: "write" });
    expect(trusted?.downloadsArtifacts).toBe(true);
    expect(trusted?.readsIssueArtifact).toBe(true);
    expect(trusted?.usesRecursiveArtifactDiscovery).toBe(true);
    expect(trusted?.reSanitizesIssueBody).toBe(true);
    expect(trusted?.hasLiveIssuePublishGuard).toBe(true);
    expect(trusted?.risk).toBe("low");
    expect(audit.findings).toHaveLength(0);
  });

  it("flags trusted issue workflows that publish without an explicit live guard", () => {
    const audit = auditWorkflows(sampleConfig(), [
      {
        path: ".github/workflows/visual-hive-failure-issue.yml",
        content: `name: Visual Hive Failure Issue
on:
  workflow_run:
    workflows: ["Visual Hive PR"]
    types: [completed]
permissions:
  contents: read
  actions: read
  issues: write
jobs:
  create-issue:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - uses: actions/github-script@v7
        with:
          script: |
            const fs = require("fs");
            function walkArtifacts(dir) {
              return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walkArtifacts(entry.name) : [entry.name]);
            }
            function redactSecretValues(value) {
              return String(value).replace(/client_secret=.*/gi, "client_secret=[REDACTED]").replace(/authorization:.*/gi, "authorization: [REDACTED]").replace(/set-cookie:.*/gi, "set-cookie: [REDACTED]").replace(/Bearer .*/gi, "Bearer [REDACTED]");
            }
            const report = JSON.parse(redactSecretValues(fs.readFileSync(walkArtifacts("visual-hive-artifacts").find((file) => file.endsWith("issues.json")), "utf8")));
            const marker = "<!-- visual-hive-issue dedupe:" + report.issues[0].dedupeFingerprint + " -->";
            await github.rest.issues.create({ body: marker + redactSecretValues(report.issues[0].body) });
`
      }
    ]);

    expect(audit.summary.trustedIssueWorkflowsMissingLivePublishGuard).toBe(1);
    expect(audit.workflows[0]?.hasLiveIssuePublishGuard).toBe(false);
    expect(audit.findings.map((finding) => finding.kind)).toContain("missing_live_issue_publish_guard");
    expect(audit.findings.find((finding) => finding.kind === "missing_live_issue_publish_guard")?.severity).toBe("high");
  });

  it("recognizes a safe trusted Hive handoff workflow that only consumes artifacts", () => {
    const audit = auditWorkflows(sampleConfig(), [
      {
        path: ".github/workflows/visual-hive-hive-handoff.yml",
        content: `name: Visual Hive Hive Handoff
on:
  workflow_run:
    workflows: ["Visual Hive PR"]
    types: [completed]
permissions:
  contents: read
  actions: read
jobs:
  validate-handoff:
    runs-on: ubuntu-latest
    if: vars.VISUAL_HIVE_AUTO_PUBLISH_ISSUES == 'true'
    steps:
      - uses: actions/download-artifact@1234567890abcdef1234567890abcdef12345678
        with:
          name: visual-hive
          path: visual-hive-artifacts
      - uses: actions/github-script@abcdef1234567890abcdef1234567890abcdef12
        with:
          script: |
            const fs = require("fs");
            function walkArtifacts(dir) {
              return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walkArtifacts(entry.name) : [entry.name]);
            }
            function redactSecretValues(value) {
              return String(value)
                .replace(/client_secret=.*/gi, "client_secret=[REDACTED]")
                .replace(/authorization:.*/gi, "authorization: [REDACTED]")
                .replace(/set-cookie:.*/gi, "set-cookie: [REDACTED]")
                .replace(/Bearer .*/gi, "Bearer [REDACTED]");
            }
            const files = walkArtifacts("visual-hive-artifacts");
            const evidence = files.find((file) => file.endsWith("evidence-packet.json"));
            const handoff = files.find((file) => file.endsWith("handoff.json"));
            const bead = files.find((file) => file.endsWith("hive-bead-request.json"));
            const result = files.find((file) => file.endsWith("hive-handoff-result.json"));
            const body = redactSecretValues(JSON.stringify({ evidence, handoff, bead, result, externalCallsMade: 0 }));
            await core.summary.addRaw(body).write();
`
      }
    ]);

    const trusted = audit.workflows[0];
    expect(audit.summary.trustedHandoffWorkflows).toBe(1);
    expect(audit.summary.trustedHandoffWorkflowsCheckingOutCode).toBe(0);
    expect(trusted?.kind).toBe("trusted_handoff");
    expect(trusted?.permissions).toMatchObject({ contents: "read", actions: "read" });
    expect(trusted?.downloadsArtifacts).toBe(true);
    expect(trusted?.checksOutCode).toBe(false);
    expect(trusted?.createsIssues).toBe(false);
    expect(trusted?.readsHiveHandoffArtifacts).toBe(true);
    expect(trusted?.usesRecursiveArtifactDiscovery).toBe(true);
    expect(trusted?.reSanitizesIssueBody).toBe(true);
    expect(trusted?.hasLiveIssuePublishGuard).toBe(true);
    expect(trusted?.risk).toBe("low");
    expect(audit.findings).toHaveLength(0);
  });

  it("does not require a separate Hive handoff workflow when a trusted issue workflow consumes handoff artifacts", () => {
    const audit = auditWorkflows(sampleConfig(), [
      {
        path: ".github/workflows/visual-hive-trusted-publisher.yml",
        content: `name: Visual Hive Trusted Publisher
on:
  workflow_run:
    workflows: ["Visual Hive PR", "Visual Hive Scheduled"]
    types: [completed]
permissions:
  actions: read
  contents: read
  issues: write
jobs:
  publish:
    runs-on: ubuntu-latest
    if: vars.VISUAL_HIVE_AUTO_PUBLISH_ISSUES == 'true'
    steps:
      - uses: actions/download-artifact@1234567890abcdef1234567890abcdef12345678
        with:
          name: visual-hive
          path: visual-hive-artifacts
      - uses: actions/github-script@abcdef1234567890abcdef1234567890abcdef12
        with:
          script: |
            const fs = require("fs");
            function walkArtifacts(dir) {
              return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walkArtifacts(entry.name) : [entry.name]);
            }
            function redactSecretValues(value) {
              return String(value)
                .replace(/client_secret=.*/gi, "client_secret=[REDACTED]")
                .replace(/authorization:.*/gi, "authorization: [REDACTED]")
                .replace(/set-cookie:.*/gi, "set-cookie: [REDACTED]")
                .replace(/Bearer .*/gi, "Bearer [REDACTED]");
            }
            const files = walkArtifacts("visual-hive-artifacts");
            const issues = files.find((file) => file.endsWith("issues.json"));
            const queue = files.find((file) => file.endsWith("issue-queue.json"));
            const handoff = files.find((file) => file.endsWith("handoff.json"));
            const validation = files.find((file) => file.endsWith("hive-handoff-validation.json"));
            const body = redactSecretValues(JSON.stringify({ issues, queue, handoff, validation }));
            await github.rest.issues.create({ body: "<!-- visual-hive-dedupe -->" + body });
`
      }
    ]);

    expect(audit.summary.trustedIssueWorkflows).toBe(1);
    expect(audit.summary.trustedHandoffWorkflows).toBe(0);
    expect(audit.workflows[0]?.readsHiveHandoffArtifacts).toBe(true);
    expect(audit.recommendations).not.toContain("Add a trusted Hive handoff workflow when agent handoff is needed.");
    expect(audit.findings).toHaveLength(0);
  });

  it("ships built-in GitHub workflow templates that audit as safe lanes", () => {
    const audit = auditWorkflows(
      sampleConfig(),
      githubWorkflowTemplates.map((template) => ({
        path: template.path,
        content: template.content
      })),
      { workflowRoot: ".github/workflows", now: new Date("2026-06-15T00:00:00.000Z") }
    );

    expect(githubWorkflowTemplates.map((template) => template.id)).toEqual([
      "pull_request",
      "scheduled",
      "trusted_failure_issue",
      "trusted_hive_handoff"
    ]);
    const prTemplate = githubWorkflowTemplates.find((template) => template.id === "pull_request")?.content ?? "";
    const scheduledTemplate = githubWorkflowTemplates.find((template) => template.id === "scheduled")?.content ?? "";
    const hiveHandoffTemplate = githubWorkflowTemplates.find((template) => template.id === "trusted_hive_handoff")?.content ?? "";
    expect(prTemplate).toContain("DavidDiaz0317/visual-hive/actions/run@main");
    expect(prTemplate).toContain("command: pipeline");
    expect(prTemplate).toContain("arguments: --mode pr --base origin/main --ci --github-step-summary");
    expect(prTemplate).not.toContain("npx visual-hive");
    expect(scheduledTemplate).toContain("DavidDiaz0317/visual-hive/actions/run@main");
    expect(scheduledTemplate).toContain("command: pipeline");
    expect(scheduledTemplate).toContain("arguments: --mode schedule --ci --enforce-mutation --github-step-summary");
    expect(scheduledTemplate).not.toContain("npx visual-hive");
    const failureIssueTemplate = githubWorkflowTemplates.find((template) => template.id === "trusted_failure_issue")?.content ?? "";
    expect(failureIssueTemplate).toContain("issues.json");
    expect(failureIssueTemplate).toContain("visual-hive-issue dedupe");
    expect(failureIssueTemplate).toContain("dedupeFingerprint");
    expect(failureIssueTemplate).toContain("Refusing trusted issue publication because issues.json reports prior external/network calls.");
    expect(failureIssueTemplate).toContain("falls back to issue.md only when older artifacts are uploaded");
    expect(failureIssueTemplate).not.toContain("context.payload.workflow_run.id + \" -->\"");
    expect(hiveHandoffTemplate).toContain("workflow_run:");
    expect(hiveHandoffTemplate).toContain("hive-bead-request.json");
    expect(hiveHandoffTemplate).toContain("hive-handoff-validation.json");
    expect(hiveHandoffTemplate).toContain("hive/hive-export.json");
    expect(hiveHandoffTemplate).toContain("hive/guarded-repair-preview.json");
    expect(hiveHandoffTemplate).toContain("hive/repair-request-envelope.json");
    expect(hiveHandoffTemplate).toContain("hive/trusted-repair-workflow-dry-run.json");
    expect(hiveHandoffTemplate).toContain("Guarded repair preview");
    expect(hiveHandoffTemplate).toContain("Repair request envelope");
    expect(hiveHandoffTemplate).toContain("Trusted repair workflow dry-run");
    expect(hiveHandoffTemplate).toContain("preview_only_no_execution");
    expect(hiveHandoffTemplate).toContain("trusted_workflow_request_only");
    expect(hiveHandoffTemplate).toContain("dry_run_only");
    expect(hiveHandoffTemplate).toContain("not_executed_by_visual_hive");
    expect(hiveHandoffTemplate).toContain("canOpenTrustedRepairRequest");
    expect(hiveHandoffTemplate).toContain("canRunTrustedRepairWorkflow");
    expect(hiveHandoffTemplate).toContain("decide_visual_hive_verdict");
    expect(hiveHandoffTemplate).toContain("hive-issue.md");
    expect(hiveHandoffTemplate).toContain("externalCallsMade");
    expect(hiveHandoffTemplate).toContain("visual-hive-hive-handoff-dedupe");
    expect(hiveHandoffTemplate).toContain("github.rest.issues.create");
    expect(hiveHandoffTemplate).toContain("Future trusted Hive Bead API adapter");
    expect(hiveHandoffTemplate).not.toContain("actions/checkout");
    expect(hiveHandoffTemplate).not.toContain("pull_request_target");
    expect(audit.summary).toMatchObject({
      pullRequestWorkflows: 1,
      scheduledWorkflows: 1,
      trustedIssueWorkflows: 1,
      trustedHandoffWorkflows: 1,
      criticalFindings: 0,
      highFindings: 0,
      workflowsUsingPullRequestTarget: 0,
      prWorkflowsUsingSecrets: 0,
      prWorkflowsWithWritePermissions: 0,
      trustedIssueWorkflowsCheckingOutCode: 0,
      trustedHandoffWorkflowsCheckingOutCode: 0,
      workflowsUsingUnpinnedActions: 4
    });
    const trusted = audit.workflows.find((workflow) => workflow.kind === "trusted_issue");
    const trustedHandoff = audit.workflows.find((workflow) => workflow.kind === "trusted_handoff");
    expect(audit.workflows.find((workflow) => workflow.kind === "pull_request")?.writesBaselineReview).toBe(true);
    expect(audit.workflows.find((workflow) => workflow.kind === "scheduled")?.writesBaselineReview).toBe(true);
    expect(trusted?.usesRecursiveArtifactDiscovery).toBe(true);
    expect(trusted?.reSanitizesIssueBody).toBe(true);
    expect(trusted?.hasLiveIssuePublishGuard).toBe(true);
    expect(trusted?.permissions).toMatchObject({ actions: "read", contents: "read", issues: "write" });
    expect(trustedHandoff?.downloadsArtifacts).toBe(true);
    expect(trustedHandoff?.checksOutCode).toBe(false);
    expect(trustedHandoff?.readsHiveHandoffArtifacts).toBe(true);
    expect(trustedHandoff?.usesRecursiveArtifactDiscovery).toBe(true);
    expect(trustedHandoff?.reSanitizesIssueBody).toBe(true);
    expect(trustedHandoff?.hasLiveIssuePublishGuard).toBe(true);
    expect(trustedHandoff?.createsIssues).toBe(true);
    expect(trustedHandoff?.hasDedupeSignature).toBe(true);
    expect(trustedHandoff?.permissions).toMatchObject({ actions: "read", contents: "read", issues: "write" });
    expect(audit.findings.filter((finding) => finding.kind === "action_not_sha_pinned").length).toBeGreaterThan(0);
    expect(audit.recommendations.join(" ")).toContain("pin external GitHub Actions");
  });
});

describe("readiness gate", () => {
  it("marks complete clean evidence as ready", () => {
    const config = sampleConfig();
    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"] });
    const report: Report = {
      schemaVersion: 2,
      project: "sample",
      repository: sampleRepository,
      mode: "pr",
      generatedAt: "2026-06-15T00:00:00.000Z",
      status: "passed",
      changedFiles: ["src/App.tsx"],
      selectedTargets: [{ id: "safe", kind: "url", url: "https://safe.example.com", prSafe: true, cost: "cheap" }],
      selectedContracts: ["safe-contract", "changed-contract"],
      excludedContracts: [],
      targetLifecycle: [],
      generatedSpecPath: ".visual-hive/generated/visual-hive.generated.spec.ts",
      results: [
        {
          contractId: "safe-contract",
          targetId: "safe",
          status: "passed",
          durationMs: 12,
          errors: [],
          artifacts: [".visual-hive/artifacts/results/safe-contract.json"],
          selectorAssertions: [{ kind: "mustExist", value: "main", status: "passed" }],
          screenshotAssertions: [
            {
              contractId: "safe-contract",
              screenshotName: "home",
              name: "home",
              route: "/",
              viewport: "desktop",
              status: "passed",
              baselinePath: ".visual-hive/snapshots/home.png",
              actualPath: ".visual-hive/artifacts/screenshots/home.png",
              maxDiffPixelRatio: 0.01,
              actualDiffPixelRatio: 0,
              actualDiffPixels: 0,
              totalPixels: 100
            }
          ],
          consoleErrors: [],
          pageErrors: [],
          networkErrors: [],
          reproductionCommand: "visual-hive run --ci"
        }
      ],
      summary: {
        passed: 1,
        failed: 0,
        screenshotsPassed: 1,
        screenshotsFailed: 0,
        baselinesCreated: 0,
        createdBaselines: 0,
        missingBaselines: 0,
        visualDiffs: 0,
        consoleErrors: 0,
        pageErrors: 0
      },
      consoleErrors: [],
      pageErrors: [],
      artifacts: [],
      reproductionCommands: ["visual-hive run --ci"]
    };
    const workflows = auditWorkflows(config, [
      {
        path: ".github/workflows/visual-hive-pr.yml",
        content: `on:
  pull_request:
permissions:
  contents: read
jobs:
  visual-hive:
    steps:
      - run: npx visual-hive plan --mode pr --ci
      - run: npx visual-hive run --ci
      - run: npx visual-hive baselines list --write
      - run: npx visual-hive report --github-step-summary
      - uses: actions/upload-artifact@v4
        with:
          path: .visual-hive
          include-hidden-files: true
`
      }
    ]);
    const baselines = {
      schemaVersion: 1 as const,
      project: "sample",
      generatedAt: "2026-06-15T00:01:00.000Z",
      reportGeneratedAt: report.generatedAt,
      reportPath: ".visual-hive/report.json",
      approvalLogPath: ".visual-hive/baseline-approvals.json",
      rejectionLogPath: ".visual-hive/baseline-rejections.json",
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        created: 0,
        missingBaseline: 0,
        approvable: 0,
        approved: 0,
        rejected: 0,
        pendingReview: 0
      },
      entries: []
    };
    const mutationReport = {
      schemaVersion: 2 as const,
      project: "sample",
      generatedAt: "2026-06-15T00:02:00.000Z",
      minScore: 0.7,
      score: 1,
      killed: 2,
      total: 2,
      results: []
    };
    const securityAudit = analyzeSecurity(config, { workflowAudit: workflows });
    const costAudit = analyzeCosts(config, { plan, report, mutationReport });

    const readiness = analyzeReadiness(config, {
      plan,
      report,
      baselines,
      mutationReport,
      workflowAudit: workflows,
      securityAudit,
      costAudit,
      providerDecisions: {
        schemaVersion: 1,
        generatedAt: "2026-06-15T00:00:00.000Z",
        decisions: [
          {
            providerId: "argos",
            label: "Argos",
            decision: "skip",
            reason: "No paid provider for this repo.",
            decidedAt: "2026-06-15T00:00:00.000Z",
            source: "cli",
            externalCallsMade: 0
          }
        ]
      },
      llmDecisions: {
        schemaVersion: 1,
        generatedAt: "2026-06-15T00:00:00.000Z",
        decisions: [
          {
            decision: "keep_disabled",
            reason: "Offline prompts only.",
            decidedAt: "2026-06-15T00:00:00.000Z",
            source: "cli",
            externalCallsMade: 0
          }
        ]
      },
      now: new Date("2026-06-15T00:03:00.000Z")
    });

    expect(readiness.schemaVersion).toBe(1);
    expect(readiness.outputResource).toMatchObject({
      artifactPath: ".visual-hive/readiness.json",
      evidenceResourceId: "readiness-gate",
      evidenceResourceUri: "visual-hive://readiness-gate",
      evidenceReadToolName: "visual_hive_read_readiness_gate"
    });
    expect(readiness.status).toBe("attention");
    expect(readiness.gates.find((gate) => gate.id === "deterministic:status")?.status).toBe("passed");
    expect(readiness.gates.find((gate) => gate.id === "baselines:clean")?.status).toBe("passed");
    expect(readiness.gates.find((gate) => gate.id === "provider:decisions-recorded")?.status).toBe("passed");
    expect(readiness.gates.find((gate) => gate.id === "llm:decisions-recorded")?.status).toBe("passed");
    expect(readiness.gates.find((gate) => gate.id === "security:posture")?.status).toBe("warning");
    expect(JSON.stringify(readiness)).not.toContain("secret-value");
  });

  it("uses provider setup plans and handoff manifests as readiness evidence for external providers", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "provider-readiness", type: "custom", defaultBranch: "main" },
      targets: { local: { kind: "url", url: "http://127.0.0.1:4173" } },
      contracts: [{ id: "dashboard", description: "Dashboard", target: "local", runOn: { pullRequest: true } }],
      providers: {
        argos: {
          enabled: true,
          mode: "external",
          requiredEnv: ["ARGOS_TOKEN"]
        }
      }
    });
    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"] });
    const setupPlan = buildProviderSetupPlan(config, { providerId: "argos", env: {}, generatedAt: "2026-06-15T00:00:00.000Z" });
    const readiness = analyzeReadiness(config, {
      plan,
      costAudit: analyzeCosts(config, { plan }),
      providerSetupPlan: setupPlan,
      now: new Date("2026-06-15T00:00:00.000Z")
    });

    expect(readiness.inputs.providerSetupPlan).toBe(true);
    expect(readiness.inputs.providerHandoff).toBe(false);
    expect(readiness.gates.find((gate) => gate.id === "provider:external-enabled")).toMatchObject({
      category: "provider",
      status: "warning"
    });
    expect(readiness.gates.find((gate) => gate.id === "provider:external-enabled")?.evidence).toEqual(
      expect.arrayContaining(["setupPlan=argos", "recommendation=blocked", "externalCallsMade=0", "handoff=missing"])
    );
    expect(readiness.gates.find((gate) => gate.id === "provider:external-enabled")?.artifacts).toContain(".visual-hive/provider-setup-plan.json");
    expect(readiness.gates.find((gate) => gate.id === "provider:external-enabled")?.artifacts).toContain(".visual-hive/provider-handoff.json");
    expect(JSON.stringify(readiness)).not.toContain("secret-value");

    const handoff = buildProviderHandoffManifest(
      config,
      reportFixture(repoRoot, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"),
      { providerId: "argos", env: {}, generatedAt: "2026-06-15T00:00:00.000Z" }
    );
    const withHandoff = analyzeReadiness(config, {
      plan,
      costAudit: analyzeCosts(config, { plan }),
      providerSetupPlan: setupPlan,
      providerHandoff: handoff,
      now: new Date("2026-06-15T00:00:00.000Z")
    });
    expect(withHandoff.inputs.providerHandoff).toBe(true);
    expect(withHandoff.gates.find((gate) => gate.id === "provider:external-enabled")?.evidence).toEqual(
      expect.arrayContaining(["handoff=argos", "status=blocked", "eligibleArtifacts=0", "externalCallsMade=0"])
    );
    expect(JSON.stringify(withHandoff)).not.toContain("secret-value");
  });

  it("builds artifact-backed setup progress and recommends the next blocked step", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-setup-progress-"));
    tempDirs.push(tempRoot);
    const config = sampleConfig();
    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"] });
    const report = reportFixture(
      tempRoot,
      path.join(tempRoot, ".visual-hive", "artifacts", "screenshots", "actual.png"),
      path.join(tempRoot, ".visual-hive", "snapshots", "baseline.png")
    );
    report.status = "passed";
    report.generatedAt = "2026-06-15T00:00:00.000Z";
    report.summary.passed = 1;
    report.summary.failed = 0;
    report.summary.screenshotsFailed = 0;
    report.summary.visualDiffs = 0;
    report.results[0]!.status = "passed";
    report.results[0]!.errors = [];
    report.results[0]!.screenshotAssertions[0]!.status = "passed";
    const mutationReport = {
      schemaVersion: 2 as const,
      project: "sample",
      generatedAt: "2026-06-15T00:00:00.000Z",
      minScore: 0.7,
      score: 0.5,
      killed: 1,
      total: 2,
      results: [
        {
          operator: "remove-demo-badge",
          status: "survived" as const,
          killed: false,
          contractIds: ["safe-contract"],
          applicable: true,
          expectedFailureKinds: ["missing_element"],
          durationMs: 10,
          errors: ["No assertion failed."],
          artifacts: [".visual-hive/mutation-report.json"]
        }
      ]
    };
    const progress = buildSetupProgress({
      config,
      plan,
      report,
      mutationReport,
      workflowAudit: auditWorkflows(config, []),
      readinessReport: analyzeReadiness(config, { plan, report, mutationReport }),
      now: new Date("2026-06-15T00:00:00.000Z")
    });

    expect(progress.schemaVersion).toBe(1);
    expect(progress.status).toBe("attention");
    expect(progress.phase).toBe("measure mutation adequacy");
    expect(progress.nextStep).toMatchObject({
      id: "mutation",
      status: "blocked",
      command: "visual-hive mutate"
    });
    expect(progress.steps.find((step) => step.id === "run")?.status).toBe("complete");
    expect(progress.steps.find((step) => step.id === "provider-governance")?.status).toBe("complete");
    expect(JSON.stringify(progress)).not.toContain("secret-value");
  });

  it("guides external provider setup progress toward no-network handoff evidence", () => {
    const config = VisualHiveConfigSchema.parse({
      ...sampleConfig(),
      providers: {
        argos: {
          enabled: true,
          mode: "external",
          requiredEnv: ["ARGOS_TOKEN"]
        }
      }
    });
    const providerSetupPlan = buildProviderSetupPlan(config, {
      providerId: "argos",
      env: {},
      generatedAt: "2026-06-15T00:00:00.000Z"
    });
    const withoutHandoff = buildSetupProgress({
      config,
      providerSetupPlan,
      now: new Date("2026-06-15T00:00:00.000Z")
    });
    const providerStep = withoutHandoff.steps.find((step) => step.id === "provider-governance");

    expect(providerStep).toMatchObject({
      status: "review",
      command: "visual-hive providers handoff --provider argos"
    });
    expect(providerStep?.evidence).toEqual(expect.arrayContaining(["setupPlan=argos", "handoff=missing"]));

    const providerHandoff = buildProviderHandoffManifest(
      config,
      reportFixture(repoRoot, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"),
      { providerId: "argos", env: {}, generatedAt: "2026-06-15T01:00:00.000Z" }
    );
    const withHandoff = buildSetupProgress({
      config,
      providerSetupPlan,
      providerHandoff,
      now: new Date("2026-06-15T01:00:00.000Z")
    });
    const completedProviderStep = withHandoff.steps.find((step) => step.id === "provider-governance");

    expect(completedProviderStep).toMatchObject({
      status: "review",
      command: "visual-hive providers list --mock-results"
    });
    expect(completedProviderStep?.evidence.join(" ")).toContain("handoff=argos:blocked");
    expect(JSON.stringify(withHandoff)).not.toContain("secret-value");
  });

  it("marks setup artifacts for review when they are older than newer deterministic evidence", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-setup-progress-stale-"));
    tempDirs.push(tempRoot);
    const config = sampleConfig();
    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"], now: new Date("2026-06-15T01:00:00.000Z") });
    const report = reportFixture(
      tempRoot,
      path.join(tempRoot, ".visual-hive", "artifacts", "screenshots", "actual.png"),
      path.join(tempRoot, ".visual-hive", "snapshots", "baseline.png")
    );
    report.generatedAt = "2026-06-15T01:00:00.000Z";
    report.status = "passed";
    report.summary.passed = 1;
    report.summary.failed = 0;
    report.summary.screenshotsFailed = 0;
    report.summary.visualDiffs = 0;
    report.results[0]!.status = "passed";
    report.results[0]!.errors = [];
    report.results[0]!.screenshotAssertions[0]!.status = "passed";
    const mutationReport = {
      schemaVersion: 2 as const,
      project: "sample",
      generatedAt: "2026-06-15T02:00:00.000Z",
      minScore: 0.7,
      score: 1,
      killed: 1,
      total: 1,
      results: [
        {
          operator: "remove-demo-badge",
          status: "killed" as const,
          killed: true,
          contractIds: ["safe-contract"],
          applicable: true,
          expectedFailureKinds: ["missing_element"],
          durationMs: 10,
          errors: [],
          artifacts: [".visual-hive/mutation-report.json"]
        }
      ]
    };
    const triageReport = buildTriageReport({
      project: "sample",
      findings: [],
      now: new Date("2026-06-15T00:00:00.000Z")
    });
    expect(triageReport.outputResource).toEqual({
      artifactPath: ".visual-hive/triage.json",
      evidenceResourceId: "triage-report",
      evidenceResourceUri: "visual-hive://triage-report",
      evidenceResourceTitle: "Triage Report",
      evidenceResourceDescription: "Offline deterministic triage classifications, likely causes, suggested tests, and repair context.",
      evidenceReadToolName: "visual_hive_read_triage_report"
    });
    const readinessReport = analyzeReadiness(config, {
      plan,
      report,
      mutationReport,
      workflowAudit: auditWorkflows(config, [], { now: new Date("2026-06-15T02:00:00.000Z") }),
      now: new Date("2026-06-15T00:30:00.000Z")
    });
    const progress = buildSetupProgress({
      config,
      plan,
      report,
      mutationReport,
      triageReport,
      workflowAudit: auditWorkflows(config, [], { now: new Date("2026-06-15T02:00:00.000Z") }),
      readinessReport,
      now: new Date("2026-06-15T03:00:00.000Z")
    });

    const mutationStep = progress.steps.find((step) => step.id === "mutation");
    const triageStep = progress.steps.find((step) => step.id === "triage");
    const readinessStep = progress.steps.find((step) => step.id === "readiness");

    expect(mutationStep).toMatchObject({ status: "complete" });
    expect(mutationStep?.evidence).toContain("mutation-report.json=current");
    expect(triageStep).toMatchObject({ status: "review" });
    expect(triageStep?.evidence).toEqual(expect.arrayContaining(["triage.json=stale", "newer=report.json,mutation-report.json"]));
    expect(readinessStep).toMatchObject({ status: "review" });
    expect(readinessStep?.evidence).toContain("readiness.json=stale");
    expect(progress.nextStep).toMatchObject({ id: "triage", status: "review" });
  });

  it("blocks readiness on deterministic failures and missing CI baselines", () => {
    const config = sampleConfig();
    const plan = createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"] });
    const report: Report = {
      schemaVersion: 2,
      project: "sample",
      repository: sampleRepository,
      mode: "pr",
      generatedAt: "2026-06-15T00:00:00.000Z",
      status: "failed",
      changedFiles: ["src/App.tsx"],
      selectedTargets: [{ id: "safe", kind: "url", url: "https://safe.example.com", prSafe: true, cost: "cheap" }],
      selectedContracts: ["safe-contract"],
      excludedContracts: [],
      targetLifecycle: [],
      generatedSpecPath: ".visual-hive/generated/visual-hive.generated.spec.ts",
      results: [],
      summary: {
        passed: 0,
        failed: 1,
        screenshotsPassed: 0,
        screenshotsFailed: 1,
        baselinesCreated: 0,
        createdBaselines: 0,
        missingBaselines: 1,
        visualDiffs: 0,
        consoleErrors: 0,
        pageErrors: 0
      },
      consoleErrors: [],
      pageErrors: [],
      artifacts: [],
      reproductionCommands: ["visual-hive run --ci"]
    };

    const readiness = analyzeReadiness(config, { plan, report });

    expect(readiness.status).toBe("blocked");
    expect(readiness.gates.find((gate) => gate.id === "deterministic:status")?.status).toBe("blocked");
    expect(readiness.gates.find((gate) => gate.id === "baselines:missing-baseline")?.status).toBe("blocked");
    expect(readiness.nextActions.join(" ")).toContain("baselines");
  });

  it("calls out missing plan and report evidence", () => {
    const readiness = analyzeReadiness(sampleConfig(), { now: new Date("2026-06-15T00:00:00.000Z") });

    expect(readiness.status).toBe("attention");
    expect(readiness.summary.missing).toBeGreaterThanOrEqual(3);
    expect(readiness.gates.map((gate) => gate.id)).toEqual(expect.arrayContaining(["planning:missing", "deterministic:missing", "workflow:missing"]));
  });

  it("blocks setup readiness for localhost URL targets without serve commands, body-only selectors, and no screenshots", () => {
    const config = VisualHiveConfigSchema.parse({
      project: { name: "weak-setup", type: "static", defaultBranch: "main" },
      targets: {
        localPreview: {
          kind: "url",
          url: "http://127.0.0.1:4173",
          prSafe: true
        }
      },
      contracts: [
        {
          id: "body-only",
          description: "Generated starter contract needs review",
          target: "localPreview",
          runOn: { pullRequest: true },
          selectors: { mustExist: ["body"] }
        }
      ]
    });

    const readiness = analyzeReadiness(config, { now: new Date("2026-06-15T00:00:00.000Z") });

    expect(readiness.status).toBe("blocked");
    expect(readiness.gates.find((gate) => gate.id === "setup:missing-serve-command")).toMatchObject({ status: "blocked" });
    expect(readiness.gates.find((gate) => gate.id === "setup:body-only-selector")).toMatchObject({ status: "blocked" });
    expect(readiness.gates.find((gate) => gate.id === "setup:no-screenshots")).toMatchObject({ status: "blocked" });
    expect(JSON.stringify(readiness)).not.toContain("secret-value");
  });

  it("blocks readiness when run history shows a pass-to-fail regression", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-readiness-history-"));
    tempDirs.push(tempRoot);
    const previousReport = reportFixture(tempRoot, path.join(tempRoot, ".visual-hive", "artifacts", "previous.png"), path.join(tempRoot, ".visual-hive", "snapshots", "baseline.png"));
    previousReport.status = "passed";
    previousReport.summary.failed = 0;
    previousReport.summary.visualDiffs = 0;
    previousReport.results[0]!.status = "passed";
    previousReport.results[0]!.errors = [];
    const latestReport = reportFixture(tempRoot, path.join(tempRoot, ".visual-hive", "artifacts", "latest.png"), path.join(tempRoot, ".visual-hive", "snapshots", "baseline.png"));
    const runHistory = createRunHistoryReport({
      project: "sample",
      generatedAt: "2026-06-15T01:01:00.000Z",
      entries: [
        createRunHistoryEntry({
          repoRoot: tempRoot,
          id: "previous",
          recordedAt: "2026-06-15T00:00:00.000Z",
          files: { report: ".visual-hive/history/previous/report.json" },
          report: previousReport
        }),
        createRunHistoryEntry({
          repoRoot: tempRoot,
          id: "latest",
          recordedAt: "2026-06-15T01:00:00.000Z",
          files: { report: ".visual-hive/history/latest/report.json" },
          report: latestReport
        })
      ]
    });

    const readiness = analyzeReadiness(sampleConfig(), { runHistory, now: new Date("2026-06-15T01:02:00.000Z") });

    expect(readiness.inputs.runHistory).toBe(true);
    expect(readiness.status).toBe("blocked");
    expect(readiness.gates.find((gate) => gate.id === "history:regressed")).toMatchObject({
      category: "history",
      status: "blocked"
    });
    expect(readiness.nextActions.join(" ")).toContain("archived reports");
  });
});

describe("security audit", () => {
  it("combines workflow, protected target, provider, LLM, and npm audit posture", () => {
    const config = VisualHiveConfigSchema.parse({
      ...sampleConfig(),
      targets: {
        ...sampleConfig().targets,
        protectedLane: {
          kind: "protected",
          url: "https://cluster.example.com",
          prSafe: true
        }
      },
      providers: {
        argos: {
          enabled: true,
          mode: "external",
          requiredEnv: ["ARGOS_TOKEN"]
        }
      },
      costPolicy: {
        maxExternalScreenshotsPerRun: 10,
        maxMonthlyExternalScreenshots: 5000,
        externalUpload: {
          pullRequest: true
        }
      },
      ai: {
        enabled: true,
        provider: "openai",
        model: "gpt-4.1",
        neverSoleOracle: true,
        maxEstimatedCostUsd: 5
      }
    });
    const workflowAudit = auditWorkflows(config, [
      {
        path: ".github/workflows/unsafe-pr.yml",
        content: `
on: pull_request_target
permissions:
  contents: write
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - run: visual-hive run
        env:
          TOKEN: \${{ secrets.SECRET_TOKEN }}
`
      }
    ]);
    const npmAudit = npmAuditSummaryFromJson({
      metadata: {
        vulnerabilities: {
          critical: 1,
          high: 2,
          moderate: 3,
          low: 4,
          info: 0,
          total: 10
        }
      }
    });

    const security = analyzeSecurity(config, { workflowAudit, npmAudit, now: new Date("2026-06-15T00:00:00.000Z") });

    expect(security.schemaVersion).toBe(1);
    expect(security.summary.critical).toBeGreaterThan(0);
    expect(security.summary.npmAuditTotal).toBe(10);
    expect(security.findings.map((finding) => finding.category)).toEqual(
      expect.arrayContaining(["workflow", "protected_target", "provider", "llm", "dependency"])
    );
    expect(security.findings.find((finding) => finding.id.includes("protectedLane"))?.title).toContain("Protected target");
    expect(JSON.stringify(security)).not.toContain("SECRET_TOKEN");
    expect(security.recommendations).toEqual(expect.arrayContaining(["Fix critical/high workflow safety findings before making Visual Hive checks required."]));
  });

  it("treats tag-pinned actions as production hardening instead of PR-blocking workflow risk", () => {
    const workflowAudit = auditWorkflows(sampleConfig(), [
      {
        path: ".github/workflows/visual-hive-pr.yml",
        content: `
on: pull_request
permissions:
  contents: read
jobs:
  visual-hive:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-artifact@v4
        with:
          include-hidden-files: true
      - run: visual-hive baselines list --write
`
      }
    ]);

    const security = analyzeSecurity(sampleConfig(), { workflowAudit, now: new Date("2026-06-15T00:00:00.000Z") });

    expect(security.summary.prBlocking).toBe(0);
    expect(security.findings.map((finding) => finding.id)).toContain("workflow:action_not_sha_pinned:.github/workflows/visual-hive-pr.yml");
    expect(security.recommendations).toContain(
      "For production hardening, pin external GitHub Actions by full commit SHA after reviewing upstream source."
    );
    expect(security.recommendations.join(" ")).not.toContain("Fix critical/high workflow safety findings");
  });

  it("keeps npm audit optional and parses object-form vulnerability output", () => {
    const audit = npmAuditSummaryFromJson({
      vulnerabilities: {
        packageA: { severity: "high" },
        packageB: { severity: "moderate" },
        packageC: { severity: "low" }
      }
    });
    const security = analyzeSecurity(sampleConfig(), { npmAudit: audit });

    expect(audit).toMatchObject({ total: 3, high: 1, moderate: 1, low: 1 });
    expect(security.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining(["dependency:npm-audit-high"]));
    expect(security.findings.some((finding) => finding.id === "dependency:npm-audit-not-run")).toBe(false);
  });
});

describe("issue-facing path leak scan", () => {
  it("passes clean issue-facing artifacts and writes a schema-valid report", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-path-scan-clean-"));
    tempDirs.push(tempRoot);
    const hiveRoot = path.join(tempRoot, ".visual-hive");
    await mkdir(path.join(hiveRoot, "agents", "visual-issue"), { recursive: true });
    await writeFile(path.join(hiveRoot, "issues.md"), "Evidence lives at `.visual-hive/report.json`.", "utf8");
    await writeFile(
      path.join(hiveRoot, "issues.json"),
      JSON.stringify({
        schemaVersion: "visual-hive.issues.v1",
        issues: [{ artifactPath: ".visual-hive/artifacts/screenshots/dashboard.png" }]
      }),
      "utf8"
    );
    await writeFile(path.join(hiveRoot, "agents", "visual-issue", "agent-request.md"), "Inspect `.visual-hive/evidence-packet.json`.", "utf8");

    const { report, outputPath } = await scanIssueFacingPaths({
      rootDir: tempRoot,
      outputPath: ".visual-hive/path-leak-scan.json",
      now: new Date("2026-07-07T12:00:00.000Z")
    });

    expect(report.status).toBe("passed");
    expect(report.summary.filesScanned).toBeGreaterThanOrEqual(3);
    expect(report.summary.findings).toBe(0);
    expect(report.scannedFiles).toContain(".visual-hive/issues.md");
    expect(outputPath).toBe(path.join(hiveRoot, "path-leak-scan.json"));
    await expectMatchesSchema("visual-hive.path-leak-scan.schema.json", report);
    await expect(readFile(path.join(hiveRoot, "path-leak-scan.json"), "utf8")).resolves.toContain("visual-hive.path-leak-scan.v1");
  });

  it("fails when issue-facing artifacts expose local absolute paths", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-path-scan-leak-"));
    tempDirs.push(tempRoot);
    const hiveRoot = path.join(tempRoot, ".visual-hive");
    await mkdir(path.join(hiveRoot, "agents", "visual-issue"), { recursive: true });
    await writeFile(
      path.join(hiveRoot, "issues.md"),
      [
        "Screenshot: C:/Users/david/OneDrive/Documents/demo/.visual-hive/artifacts/screenshots/dashboard.png",
        "Log: /home/runner/work/demo/.visual-hive/report.json"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(hiveRoot, "agents", "visual-issue", "agent-output.md"),
      "Inspect C:\\Users\\david\\OneDrive\\Documents\\demo\\.visual-hive\\evidence-packet.json",
      "utf8"
    );

    const { report } = await scanIssueFacingPaths({
      rootDir: tempRoot,
      outputPath: ".visual-hive/path-leak-scan.json",
      now: new Date("2026-07-07T12:00:00.000Z")
    });

    expect(report.status).toBe("failed");
    expect(report.summary.findings).toBeGreaterThanOrEqual(3);
    expect(report.findings.map((finding) => finding.file)).toEqual(
      expect.arrayContaining([".visual-hive/issues.md", ".visual-hive/agents/visual-issue/agent-output.md"])
    );
    expect(report.findings.map((finding) => finding.patternId)).toEqual(
      expect.arrayContaining(["windows-user-slash-path", "onedrive-path", "posix-home-path", "windows-user-path"])
    );
    await expectMatchesSchema("visual-hive.path-leak-scan.schema.json", report);
  });
});

describe("cost audit", () => {
  it("explains local/external cost posture without planning external calls", () => {
    const config = VisualHiveConfigSchema.parse({
      ...sampleConfig(),
      providers: {
        argos: {
          enabled: true,
          mode: "external",
          requiredEnv: ["ARGOS_TOKEN"]
        }
      },
      costPolicy: {
        maxExternalScreenshotsPerRun: 0,
        maxMonthlyExternalScreenshots: 20,
        externalUpload: {
          pullRequest: true,
          schedule: true,
          manual: true,
          canary: false,
          mutation: false,
          full: true,
          onFailureOnly: false,
          criticalContractsOnly: false
        }
      }
    });
    const cost = analyzeCosts(config, {
      plan: createPlan(config, { mode: "pr", changedFiles: ["src/App.tsx"], now: new Date("2026-06-15T00:00:00.000Z") }),
      env: {}
    });

    expect(cost.schemaVersion).toBe(1);
    expect(cost.summary.externalCallsPlanned).toBe(0);
    expect(cost.summary.localScreenshots).toBeGreaterThan(0);
    expect(cost.summary.maxExternalScreenshotsPerRun).toBe(0);
    expect(cost.providers.find((provider) => provider.providerId === "argos")).toMatchObject({
      enabled: true,
      availability: "missing_credentials",
      externalCallsPlanned: 0,
      missingEnv: ["ARGOS_TOKEN"]
    });
    expect(cost.risks.map((risk) => risk.id)).toEqual(expect.arrayContaining(["external-upload-pr", "screenshot-budget-exceeded"]));
    expect(JSON.stringify(cost)).not.toContain("abc123");
  });
});

describe("mutation score", () => {
  it("calculates killed over total", () => {
    expect(calculateMutationScore([{ killed: true }, { killed: false }, { killed: true }])).toEqual({
      killed: 2,
      total: 3,
      score: 2 / 3
    });
  });

  it("returns zero for empty mutation sets", () => {
    expect(calculateMutationScore([])).toEqual({ killed: 0, total: 0, score: 0 });
  });

  it("excludes non-applicable mutations from score", () => {
    expect(calculateMutationScore([{ killed: false, applicable: false }, { killed: true, applicable: true }])).toEqual({
      killed: 1,
      total: 1,
      score: 1
    });
  });

  it("builds mutation reports with catalog-backed output resource metadata", () => {
    const report = buildMutationReport({
      project: "sample",
      minScore: 0.7,
      now: new Date("2026-06-15T00:00:00.000Z"),
      results: [
        {
          operator: "hide-critical-button",
          status: "killed",
          killed: true,
          applicable: true,
          contractIds: ["safe-contract"],
          expectedFailureKinds: ["missing_element"],
          durationMs: 10,
          errors: ["Missing critical button"]
        }
      ]
    });

    expect(report.outputResource).toEqual({
      artifactPath: ".visual-hive/mutation-report.json",
      evidenceResourceId: "mutation-report",
      evidenceResourceUri: "visual-hive://mutation-report",
      evidenceResourceTitle: "Mutation Report",
      evidenceResourceDescription: "Mutation adequacy report and survivor evidence.",
      evidenceReadToolName: "visual_hive_read_mutation_report"
    });
    expect(report.score).toBe(1);
    expect(report.results[0]).toMatchObject({
      affected: [{ contractId: "safe-contract" }],
      validationCommand: "visual-hive mutate --config visual-hive.config.yaml --enforce-min-score",
      mutationMode: "runtime",
      sourceMutation: false,
      suggestedMissingTest: expect.stringContaining("hide-critical-button")
    });
  });

  it("maps mutation operators to contracts explicitly and heuristically", () => {
    const config = sampleConfig();
    const explicit = selectContractsForMutation({ id: "hide-critical-button", contracts: ["safe-contract"] }, config.contracts);
    expect(explicit.contractIds).toEqual(["safe-contract"]);

    const heuristic = selectContractsForMutation("force-login-on-demo", [
      {
        ...config.contracts[0],
        id: "login-guard",
        selectors: { mustExist: [], mustNotExist: ["[data-testid='login-page']"], textMustExist: [], textMustNotExist: [] }
      }
    ]);
    expect(heuristic.contractIds).toEqual(["login-guard"]);
  });

  it("accepts and documents the complete built-in mutation operator set", () => {
    const operatorIds = [
      "hide-critical-button",
      "force-login-on-demo",
      "remove-demo-badge",
      "api-500",
      "empty-data",
      "mobile-overflow",
      "route-guard-bypass",
      "hidden-error-banner",
      "broken-image",
      "removed-accessible-name",
      "theme-token-drift",
      "stale-loading-state"
    ] as const;
    const config = VisualHiveConfigSchema.parse({
      project: { name: "mutations" },
      targets: { local: { kind: "url", url: "http://127.0.0.1:4173" } },
      contracts: [{ id: "home", description: "home", target: "local" }],
      mutation: {
        enabled: true,
        operators: operatorIds
      }
    });

    expect(config.mutation.operators).toEqual(operatorIds);
    expect(Object.keys(MUTATION_OPERATOR_METADATA).sort()).toEqual([...operatorIds].sort());
    for (const operatorId of operatorIds) {
      expect(MUTATION_OPERATOR_METADATA[operatorId].description.length).toBeGreaterThan(10);
      expect(MUTATION_OPERATOR_METADATA[operatorId].expectedFailureKinds.length).toBeGreaterThan(0);
    }
  });

  it("heuristically maps extended mutation operators to relevant contracts", () => {
    const contracts = VisualHiveConfigSchema.parse({
      project: { name: "extended-mutations" },
      targets: { local: { kind: "url", url: "http://127.0.0.1:4173" } },
      contracts: [
        {
          id: "auth-guard",
          description: "Public route guard should not expose protected UI",
          target: "local",
          selectors: { mustNotExist: ["[data-testid='protected-route']"] }
        },
        {
          id: "error-state",
          description: "API error banner should render",
          target: "local",
          selectors: { mustExist: ["[data-testid='error-banner']"] }
        },
        {
          id: "hero-image",
          description: "Logo image should render",
          target: "local",
          selectors: { mustExist: ["img[alt='Logo']"] },
          screenshots: [{ name: "home", route: "/", viewport: "desktop" }]
        },
        {
          id: "accessible-button",
          description: "Critical accessible button remains labeled",
          target: "local",
          selectors: { mustExist: ["button[aria-label='Deploy']"], textMustExist: ["Deploy"] }
        },
        {
          id: "theme",
          description: "Theme token visual stability",
          target: "local",
          screenshots: [{ name: "theme", route: "/", viewport: "desktop" }]
        },
        {
          id: "loading",
          description: "Loaded dashboard should not show stale loading spinner",
          target: "local",
          selectors: { mustNotExist: ["[data-testid='loading-state']"] }
        }
      ],
      viewports: { desktop: { width: 1440, height: 900 } }
    }).contracts;

    expect(selectContractsForMutation("route-guard-bypass", contracts).contractIds).toEqual(["auth-guard"]);
    expect(selectContractsForMutation("hidden-error-banner", contracts).contractIds).toEqual(["error-state"]);
    expect(selectContractsForMutation("broken-image", contracts).contractIds).toContain("hero-image");
    expect(selectContractsForMutation("removed-accessible-name", contracts).contractIds).toContain("accessible-button");
    expect(selectContractsForMutation("theme-token-drift", contracts).contractIds).toContain("theme");
    expect(selectContractsForMutation("stale-loading-state", contracts).contractIds).toContain("loading");
  });
});

describe("baseline management", () => {
  it("lists and approves a screenshot baseline with an audit record", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-baseline-"));
    tempDirs.push(tempRoot);
    const hiveRoot = path.join(tempRoot, ".visual-hive");
    const actualPath = path.join(hiveRoot, "artifacts", "screenshots", "dashboard.png");
    const baselinePath = path.join(hiveRoot, "snapshots", "dashboard.png");
    const reportPath = path.join(hiveRoot, "report.json");
    await mkdir(path.dirname(actualPath), { recursive: true });
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(actualPath, "approved-image", "utf8");
    await writeFile(baselinePath, "old-image", "utf8");
    await writeFile(reportPath, JSON.stringify(reportFixture(tempRoot, actualPath, baselinePath), null, 2), "utf8");

    const list = await listBaselines({ repoRoot: tempRoot, reportPath });
    expect(list.summary).toMatchObject({
      total: 1,
      failed: 1,
      approvable: 1,
      pendingReview: 1
    });
    expect(list.entries[0]).toMatchObject({
      contractId: "dashboard",
      screenshotName: "desktop",
      status: "failed",
      canApprove: true
    });
    expect(list.outputResource).toMatchObject({
      artifactPath: ".visual-hive/baselines.json",
      evidenceResourceId: "baseline-review",
      evidenceResourceUri: "visual-hive://baseline-review",
      evidenceReadToolName: "visual_hive_read_baseline_review"
    });

    const approval = await approveBaseline({
      repoRoot: tempRoot,
      reportPath,
      contractId: "dashboard",
      screenshotName: "desktop",
      viewport: "desktop"
    });

    expect(approval.bytes).toBe("approved-image".length);
    await expect(readFile(baselinePath, "utf8")).resolves.toBe("approved-image");
    const approvalLog = JSON.parse(await readFile(path.join(hiveRoot, "baseline-approvals.json"), "utf8")) as {
      outputResource?: Record<string, unknown>;
      approvals: unknown[];
    };
    expect(approvalLog.approvals).toHaveLength(1);
    expect(approvalLog.outputResource).toMatchObject({
      artifactPath: ".visual-hive/baseline-approvals.json",
      evidenceResourceId: "baseline-approvals",
      evidenceResourceUri: "visual-hive://baseline-approvals",
      evidenceReadToolName: "visual_hive_read_baseline_approvals"
    });

    const written = await writeBaselineReview({ repoRoot: tempRoot, reportPath, now: new Date("2026-06-16T00:00:00.000Z") });
    expect(written.baselineReportPath).toBe(path.join(hiveRoot, "baselines.json"));
    expect(written.list.outputResource).toMatchObject({
      artifactPath: ".visual-hive/baselines.json",
      evidenceResourceId: "baseline-review",
      evidenceResourceUri: "visual-hive://baseline-review",
      evidenceReadToolName: "visual_hive_read_baseline_review"
    });
    expect(written.list.summary.approved).toBe(1);
    expect(written.list.summary.pendingReview).toBe(0);
    await expect(readFile(written.baselineReportPath, "utf8")).resolves.toContain('"approved": 1');
  });

  it("rejects a screenshot baseline without modifying the baseline image", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-baseline-reject-"));
    tempDirs.push(tempRoot);
    const hiveRoot = path.join(tempRoot, ".visual-hive");
    const actualPath = path.join(hiveRoot, "artifacts", "screenshots", "dashboard.png");
    const baselinePath = path.join(hiveRoot, "snapshots", "dashboard.png");
    const reportPath = path.join(hiveRoot, "report.json");
    await mkdir(path.dirname(actualPath), { recursive: true });
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(actualPath, "changed-image", "utf8");
    await writeFile(baselinePath, "approved-image", "utf8");
    await writeFile(reportPath, JSON.stringify(reportFixture(tempRoot, actualPath, baselinePath), null, 2), "utf8");

    const rejection = await rejectBaseline({
      repoRoot: tempRoot,
      reportPath,
      contractId: "dashboard",
      screenshotName: "desktop",
      reason: "Not an intentional visual change"
    });

    expect(rejection.reason).toBe("Not an intentional visual change");
    await expect(readFile(baselinePath, "utf8")).resolves.toBe("approved-image");
    const rejectionLog = JSON.parse(await readFile(path.join(hiveRoot, "baseline-rejections.json"), "utf8")) as {
      outputResource?: Record<string, unknown>;
      rejections: unknown[];
    };
    expect(rejectionLog.rejections).toHaveLength(1);
    expect(rejectionLog.outputResource).toMatchObject({
      artifactPath: ".visual-hive/baseline-rejections.json",
      evidenceResourceId: "baseline-rejections",
      evidenceResourceUri: "visual-hive://baseline-rejections",
      evidenceReadToolName: "visual_hive_read_baseline_rejections"
    });
    const list = await listBaselines({ repoRoot: tempRoot, reportPath });
    expect(list.entries[0]?.rejectedAt).toBeTruthy();
    expect(list.entries[0]?.rejectionReason).toBe("Not an intentional visual change");
    expect(list.summary.rejected).toBe(1);
    expect(list.summary.pendingReview).toBe(0);
    expect(list.rejectionLogPath).toContain("baseline-rejections.json");
  });

  it("refuses to approve baselines outside the repo root", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-baseline-escape-"));
    tempDirs.push(tempRoot);
    const hiveRoot = path.join(tempRoot, ".visual-hive");
    const actualPath = path.join(hiveRoot, "artifacts", "screenshots", "dashboard.png");
    const reportPath = path.join(hiveRoot, "report.json");
    await mkdir(path.dirname(actualPath), { recursive: true });
    await writeFile(actualPath, "image", "utf8");
    await writeFile(reportPath, JSON.stringify(reportFixture(tempRoot, actualPath, path.join(tempRoot, "..", "escape.png")), null, 2), "utf8");

    await expect(
      approveBaseline({
        repoRoot: tempRoot,
        reportPath,
        contractId: "dashboard",
        screenshotName: "desktop"
      })
    ).rejects.toThrow(/outside repository root/);
  });
});

describe("run history", () => {
  it("archives latest artifacts, summarizes trends, and sanitizes copied text artifacts", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-history-"));
    tempDirs.push(tempRoot);
    const hiveRoot = path.join(tempRoot, ".visual-hive");
    await mkdir(hiveRoot, { recursive: true });
    await writeFile(
      path.join(hiveRoot, "report.json"),
      JSON.stringify(reportFixture(tempRoot, path.join(hiveRoot, "artifacts", "actual.png"), path.join(hiveRoot, "snapshots", "baseline.png")), null, 2),
      "utf8"
    );
    await writeFile(
      path.join(hiveRoot, "mutation-report.json"),
      JSON.stringify(
        {
          schemaVersion: 2,
          project: "baseline-fixture",
          generatedAt: "2026-06-15T00:01:00.000Z",
          minScore: 0.7,
          score: 0.5,
          killed: 1,
          total: 2,
          results: []
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(path.join(hiveRoot, "issue.md"), "token=abc123 should be redacted", "utf8");
    await writeFile(path.join(hiveRoot, "pr-comment.md"), "Authorization: Bearer pr-comment-secret", "utf8");
    await writeFile(path.join(hiveRoot, "baseline-review.md"), "client_secret=baseline-review-secret", "utf8");
    await writeFile(path.join(hiveRoot, "flows.json"), '{"schemaVersion":1,"flows":[]}', "utf8");
    await writeJson(path.join(hiveRoot, "triage.json"), buildTriageReport({
      project: "baseline-fixture",
      findings: [
        {
          classification: "visual_diff",
          severity: "medium",
          title: "Diff includes token=abc123",
          evidence: ["Authorization: Bearer history-secret"],
          suggestedFiles: ["src/App.tsx"],
          suggestedNextTests: ["Add a focused screenshot contract."]
        }
      ],
      now: new Date("2026-06-15T00:01:30.000Z")
    }));

    const history = await recordRunHistory({
      repoRoot: tempRoot,
      now: new Date("2026-06-15T00:02:00.000Z"),
      runId: "run-one"
    });

    expect(history.summary).toMatchObject({
      runCount: 1,
      failedRuns: 1,
      latestStatus: "failed",
      latestMutationScore: 0.5,
      totalVisualDiffs: 1
    });
    expect(history.trend).toMatchObject({
      hasPrevious: false,
      direction: "unknown"
    });
    expect(history.outputResource).toMatchObject({
      artifactPath: ".visual-hive/history.json",
      evidenceResourceId: "run-history",
      evidenceResourceUri: "visual-hive://run-history",
      evidenceReadToolName: "visual_hive_read_run_history"
    });
    expect(history.entries[0]?.files.report).toBe(".visual-hive/history/run-one/report.json");
    expect(history.entries[0]?.files.issue).toBe(".visual-hive/history/run-one/issue.md");
    expect(history.entries[0]?.files.prComment).toBe(".visual-hive/history/run-one/pr-comment.md");
    expect(history.entries[0]?.files.baselineReview).toBe(".visual-hive/history/run-one/baseline-review.md");
    expect(history.entries[0]?.files.triageReport).toBe(".visual-hive/history/run-one/triage.json");
    expect(history.entries[0]?.files.flows).toBe(".visual-hive/history/run-one/flows.json");
    await expect(readFile(path.join(hiveRoot, "history", "run-one", "issue.md"), "utf8")).resolves.toContain("[REDACTED]");
    await expect(readFile(path.join(hiveRoot, "history", "run-one", "pr-comment.md"), "utf8")).resolves.toContain("[REDACTED]");
    await expect(readFile(path.join(hiveRoot, "history", "run-one", "baseline-review.md"), "utf8")).resolves.toContain("[REDACTED]");
    const index = JSON.parse(await readFile(path.join(hiveRoot, "history.json"), "utf8")) as {
      entries: unknown[];
      outputResource?: Record<string, unknown>;
    };
    expect(index.entries).toHaveLength(1);
    expect(index.outputResource).toMatchObject({
      artifactPath: ".visual-hive/history.json",
      evidenceResourceId: "run-history",
      evidenceResourceUri: "visual-hive://run-history",
      evidenceReadToolName: "visual_hive_read_run_history"
    });
  });

  it("calculates latest-vs-previous run trend evidence", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-history-trend-"));
    tempDirs.push(tempRoot);
    const previousReport = reportFixture(tempRoot, path.join(tempRoot, ".visual-hive", "artifacts", "previous.png"), path.join(tempRoot, ".visual-hive", "snapshots", "baseline.png"));
    const latestReport = reportFixture(tempRoot, path.join(tempRoot, ".visual-hive", "artifacts", "latest.png"), path.join(tempRoot, ".visual-hive", "snapshots", "baseline.png"));
    latestReport.status = "passed";
    latestReport.summary.failed = 0;
    latestReport.summary.visualDiffs = 0;
    latestReport.summary.screenshotsFailed = 0;
    latestReport.results[0]!.status = "passed";
    latestReport.results[0]!.errors = [];

    const previousEntry = createRunHistoryEntry({
      repoRoot: tempRoot,
      id: "previous",
      recordedAt: "2026-06-15T00:00:00.000Z",
      files: { report: ".visual-hive/history/previous/report.json" },
      report: previousReport,
      mutationReport: {
        schemaVersion: 2,
        project: "baseline-fixture",
        generatedAt: "2026-06-15T00:00:00.000Z",
        minScore: 0.7,
        score: 0.4,
        killed: 2,
        total: 5,
        results: []
      }
    });
    const latestEntry = createRunHistoryEntry({
      repoRoot: tempRoot,
      id: "latest",
      recordedAt: "2026-06-15T01:00:00.000Z",
      files: { report: ".visual-hive/history/latest/report.json" },
      report: latestReport,
      mutationReport: {
        schemaVersion: 2,
        project: "baseline-fixture",
        generatedAt: "2026-06-15T01:00:00.000Z",
        minScore: 0.7,
        score: 0.8,
        killed: 4,
        total: 5,
        results: []
      }
    });

    const history = createRunHistoryReport({
      project: "baseline-fixture",
      generatedAt: "2026-06-15T01:01:00.000Z",
      entries: [previousEntry, latestEntry]
    });

    expect(history.entries.map((entry) => entry.id)).toEqual(["latest", "previous"]);
    expect(history.outputResource).toMatchObject({
      artifactPath: ".visual-hive/history.json",
      evidenceResourceId: "run-history",
      evidenceResourceUri: "visual-hive://run-history",
      evidenceReadToolName: "visual_hive_read_run_history"
    });
    expect(history.trend).toMatchObject({
      hasPrevious: true,
      direction: "improved",
      statusChanged: { from: "failed", to: "passed" },
      mutationScoreDelta: 0.4,
      failedContractsDelta: -1,
      visualDiffsDelta: -1
    });
    expect(history.trend.reasons.join(" ")).toContain("Deterministic status recovered");
    expect(history.trend.reasons.join(" ")).toContain("Mutation score improved");
  });
});

describe("LLM usage governance", () => {
  it("defines the default prompt artifacts used by CLI and Control Plane governance", () => {
    expect(KNOWN_LLM_PROMPT_ARTIFACTS.map((artifact) => artifact.path)).toEqual([
      ".visual-hive/triage-prompt.md",
      ".visual-hive/repair-prompt.md",
      ".visual-hive/missing-tests.md",
      ".visual-hive/baseline-review.md",
      ".visual-hive/issue.md"
    ]);
    expect(KNOWN_LLM_PROMPT_ARTIFACTS.map((artifact) => artifact.task)).toEqual([
      "visual_failure_triage",
      "repair_prompt",
      "missing_tests",
      "baseline_review_summary",
      "issue_draft"
    ]);
  });

  it("records prompt-only token and cost estimates without API calls", () => {
    const config = VisualHiveConfigSchema.parse({
      ...sampleConfig(),
      ai: {
        enabled: true,
        provider: "openai",
        model: "gpt-4o-mini",
        neverSoleOracle: true,
        createIssuePrompt: true,
        maxDailyRuns: 5,
        maxPromptTokens: 10,
        maxEstimatedCostUsd: 1
      }
    });

    const usage = buildLLMUsageReport(
      config,
      [{ task: "repair_prompt", path: ".visual-hive/repair-prompt.md", content: "x".repeat(100) }],
      { now: new Date("2026-06-15T00:00:00.000Z") }
    );

    expect(usage.schemaVersion).toBe(1);
    expect(usage.summary.callsMade).toBe(0);
    expect(usage.summary.promptOnly).toBe(true);
    expect(usage.records[0]).toMatchObject({
      task: "repair_prompt",
      promptOnly: true,
      advisoryOnly: true,
      callsMade: 0,
      status: "blocked_by_token_budget",
      estimatedTokens: 25
    });
  });

  it("records LLM governance decisions in core without leaking secrets or making model calls", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-llm-decision-"));
    tempDirs.push(tempRoot);
    const decisionPath = path.join(tempRoot, ".visual-hive", "llm-decisions.json");

    const result = await recordLLMDecision(decisionPath, {
      decision: "approve_trusted_prompt_only",
      reason: "Review prompts later with OPENAI_API_KEY=abc123, but never use LLM output as pass/fail.",
      source: "control-plane",
      now: new Date("2026-06-16T00:00:00.000Z")
    });
    const log = await readLLMDecisionLog(decisionPath);

    expect(result.decisionPath).toBe(".visual-hive/llm-decisions.json");
    expect(result.decision).toMatchObject({
      decision: "approve_trusted_prompt_only",
      source: "control-plane",
      externalCallsMade: 0
    });
    expect(result.decision.reason).toContain("[REDACTED]");
    expect(JSON.stringify(log)).not.toContain("abc123");
    expect(log?.decisions[0].externalCallsMade).toBe(0);
  });
});

describe("artifact index", () => {
  it("classifies artifacts and creates sanitized previews", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-artifacts-"));
    tempDirs.push(tempRoot);
    const hiveRoot = path.join(tempRoot, ".visual-hive");
    await mkdir(path.join(hiveRoot, "artifacts", "screenshots"), { recursive: true });
    await writeFile(path.join(hiveRoot, "report.json"), '{"token":"abc123","status":"failed"}', "utf8");
    await writeFile(path.join(hiveRoot, "plan.canary.json"), '{"schemaVersion":1,"mode":"canary","changedFiles":["src/App.tsx"]}', "utf8");
    await writeFile(path.join(hiveRoot, "plans.json"), '{"schemaVersion":1,"lanes":[{"path":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "repo-map.json"), '{"schemaVersion":1,"riskSignals":[{"message":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "repo-context.md"), "Repo token=abc123", "utf8");
    await writeFile(path.join(hiveRoot, "testing-layers.json"), '{"schemaVersion":1,"recommendations":["token=abc123"]}', "utf8");
    await writeFile(path.join(hiveRoot, "testing-layers.md"), "Layer token=abc123", "utf8");
    await writeFile(path.join(hiveRoot, "test-creation-plan.json"), '{"schemaVersion":"visual-hive.test-creation-plan.v1","recommendations":[{"title":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "test-creation-plan.md"), "Test creation token=abc123", "utf8");
    await writeFile(path.join(hiveRoot, "verdict.json"), '{"schemaVersion":"visual-hive.verdict.v1","summary":{"visualHiveVerdict":"failed","failedBecause":["token=abc123"]}}', "utf8");
    await writeFile(path.join(hiveRoot, "verdict.md"), "Verdict token=abc123", "utf8");
    await writeFile(path.join(hiveRoot, "setup-pr-plan.json"), '{"schemaVersion":1,"summary":{"externalCallsMade":0},"warnings":["token=abc123"]}', "utf8");
    await writeFile(path.join(hiveRoot, "triage.json"), '{"schemaVersion":1,"findings":[{"title":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "history.json"), '{"schemaVersion":1,"runs":[{"status":"failed","message":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "baselines.json"), '{"summary":{"pendingReview":1},"entries":[{"actualPath":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "baseline-approvals.json"), '{"schemaVersion":1,"approvals":[{"actualPath":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "baseline-rejections.json"), '{"schemaVersion":1,"rejections":[{"reason":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "triage-prompt.md"), "Authorization: Bearer secret-token", "utf8");
    await writeFile(path.join(hiveRoot, "baseline-review.md"), "client_secret=baseline-review-secret", "utf8");
    await writeFile(path.join(hiveRoot, "pr-comment.md"), "Cookie: session=secret-token", "utf8");
    await writeFile(path.join(hiveRoot, "control-plane-actions.json"), '{"actions":[{"stdout":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "coverage-recommendations.json"), '{"recommendations":[{"rationale":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "flows.json"), '{"schemaVersion":1,"flows":[{"latestFailedMessages":["token=abc123"]}]}', "utf8");
    await writeFile(path.join(hiveRoot, "workflows.json"), '{"schemaVersion":1,"findings":[{"message":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "security.json"), '{"findings":[{"evidence":["authorization: bearer abc123"]}]}', "utf8");
    await writeFile(path.join(hiveRoot, "costs.json"), '{"providers":[{"blockedReasons":["client_secret=abc123"]}]}', "utf8");
    await writeFile(path.join(hiveRoot, "readiness.json"), '{"gates":[{"evidence":["token=abc123"]}]}', "utf8");
    await writeFile(path.join(hiveRoot, "provider-decisions.json"), '{"decisions":[{"providerId":"argos","reason":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "provider-setup-plan.json"), '{"providerId":"argos","warnings":["token=abc123"]}', "utf8");
    await writeFile(path.join(hiveRoot, "provider-handoff.json"), '{"providerId":"argos","warnings":["token=abc123"]}', "utf8");
    await mkdir(path.join(hiveRoot, "provider-upload", "argos"), { recursive: true });
    await writeFile(path.join(hiveRoot, "provider-upload", "argos", "manifest.json"), '{"schemaVersion":1,"provider":"argos","warnings":["token=abc123"]}', "utf8");
    await writeFile(path.join(hiveRoot, "llm-decisions.json"), '{"decisions":[{"decision":"keep_disabled","reason":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "agent-packet.json"), '{"schemaVersion":"visual-hive.agent-packet.v1","objective":"token=abc123"}', "utf8");
    await writeFile(path.join(hiveRoot, "handoff-agent-packet.json"), '{"schemaVersion":"visual-hive.agent-packet.v1","profile":"handoff_agent","objective":"token=abc123"}', "utf8");
    await writeFile(path.join(hiveRoot, "provider-agent-packet.json"), '{"schemaVersion":"visual-hive.agent-packet.v1","profile":"provider_specialist","objective":"token=abc123"}', "utf8");
    await mkdir(path.join(hiveRoot, "tools"), { recursive: true });
    await writeFile(path.join(hiveRoot, "tools", "tool-registry.json"), '{"schemaVersion":"visual-hive.tool-registry.v1","tools":[{"id":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "tools", "tool-cards.md"), "Authorization: Bearer tool-secret", "utf8");
    await writeFile(
      path.join(hiveRoot, "mcp-manifest.json"),
      '{"schemaVersion":"visual-hive.mcp.v1","generatedAt":"2026-06-15T00:00:00.000Z","project":"artifact-fixture","server":{"name":"visual-hive","transport":"stdio","version":"0.2.2","defaultAccess":"read_only","externalCallsMade":0},"resources":[],"tools":[],"disabledExecutionTools":["visual_hive_run"],"policy":{"readOnlyByDefault":true,"externalNetworkByDefault":false,"thirdPartyMcpExposed":false,"prWritesAllowed":false,"providerUploadsAllowed":false,"llmVerdictAuthority":false},"notes":["token=abc123"]}',
      "utf8"
    );
    await writeFile(
      path.join(hiveRoot, "context-ledger.json"),
      JSON.stringify({
        schemaVersion: "visual-hive.context-ledger.v1",
        toolCalls: [
          {
            id: "triage",
            source: "pipeline",
            toolId: "visual_hive_triage",
            label: "Triage token=abc123",
            access: "local_execution",
            status: "passed",
            trustedOnly: false,
            externalNetwork: false,
            evidenceResourceId: "triage-report",
            evidenceResourceUri: "visual-hive://triage-report",
            evidenceResourceTitle: "Triage Report",
            evidenceResourceDescription: "Read deterministic triage classifications.",
            evidenceReadToolName: "visual_hive_read_triage_report",
            evidenceResources: [
              {
                evidenceResourceId: "triage-report",
                evidenceResourceUri: "visual-hive://triage-report",
                evidenceResourceTitle: "Triage Report",
                evidenceResourceDescription: "Read deterministic triage classifications.",
                evidenceReadToolName: "visual_hive_read_triage_report",
                artifactPath: ".visual-hive/triage.json"
              },
              {
                evidenceResourceId: "issue-body",
                evidenceResourceUri: "visual-hive://issue-body",
                evidenceResourceTitle: "GitHub Issue Body",
                evidenceResourceDescription: "Read sanitized GitHub issue Markdown.",
                evidenceReadToolName: "visual_hive_read_issue_body",
                artifactPath: ".visual-hive/issue.md"
              },
              {
                evidenceResourceId: "missing-tests",
                evidenceResourceUri: "visual-hive://missing-tests",
                evidenceResourceTitle: "Missing Tests",
                evidenceResourceDescription: "Read missing-test recommendations.",
                evidenceReadToolName: "visual_hive_read_missing_tests",
                artifactPath: ".visual-hive/missing-tests.md"
              }
            ],
            estimatedResultTokens: 600,
            artifacts: [".visual-hive/triage.json", ".visual-hive/issue.md", ".visual-hive/missing-tests.md"],
            reason: "Recorded from .visual-hive/pipeline.json with token=abc123"
          }
        ],
        notes: ["token=abc123"]
      }),
      "utf8"
    );
    await writeFile(
      path.join(hiveRoot, "pipeline.json"),
      '{"schemaVersion":1,"project":"artifact-fixture","mode":"pr","generatedAt":"2026-06-15T00:00:00.000Z","status":"passed","exitCode":0,"options":{"ci":true,"bootstrapBaselines":false,"enforceMutation":false,"continueOnError":true,"skipInstall":true,"skipBuild":true},"steps":[{"id":"evidence","label":"Evidence Packet","status":"passed","startedAt":"2026-06-15T00:00:00.000Z","completedAt":"2026-06-15T00:00:01.000Z","durationMs":1000,"exitCode":0,"artifacts":[".visual-hive/evidence-packet.json"],"message":"token=abc123"}],"artifacts":[".visual-hive/pipeline.json"]}',
      "utf8"
    );
    await writeFile(path.join(hiveRoot, "hive-handoff-validation.json"), '{"schemaVersion":"visual-hive.handoff-validation.v1","warnings":["token=abc123"]}', "utf8");
    await mkdir(path.join(hiveRoot, "hive"), { recursive: true });
    await writeFile(
      path.join(hiveRoot, "hive", "beads.json"),
      '[{"id":"vh-bead-1","title":"token=abc123","type":"bug","status":"open","priority":1,"actor":"quality","external_ref":"visual-hive://latest-evidence","metadata":{"secret":"token=abc123"},"notes":"token=abc123","created_at":"2026-06-15T00:00:00.000Z","updated_at":"2026-06-15T00:00:00.000Z","depends_on":[]}]',
      "utf8"
    );
    await writeFile(
      path.join(hiveRoot, "hive", "knowledge-facts.json"),
      '[{"slug":"visual-hive-regression","title":"token=abc123","type":"regression","layer":"project","confidence":0.9,"tags":["visual-hive"],"source":"visual-hive:evidence","body":"token=abc123","relatedEvidenceKeys":["selector.dashboard"],"artifacts":[".visual-hive/evidence-packet.json"]}]',
      "utf8"
    );
    await writeFile(
      path.join(hiveRoot, "hive", "knowledge-graph.json"),
      '{"schemaVersion":"visual-hive.hive-knowledge-graph.v1","nodes":[{"id":"fact:visual-hive-regression","slug":"visual-hive-regression","title":"token=abc123","type":"fact","tags":["visual-hive"],"artifactPath":".visual-hive/hive/knowledge-facts.json"}],"edges":[]}',
      "utf8"
    );
    await writeFile(
      path.join(hiveRoot, "hive", "wiki-index.json"),
      '{"schemaVersion":"visual-hive.hive-wiki-index.v1","generatedAt":"2026-06-15T00:00:00.000Z","project":"artifact-fixture","externalCallsMade":0,"wikiVaultDir":".visual-hive/hive/wiki","pages":[{"slug":"visual-hive-regression","title":"token=abc123","type":"regression","source":"visual-hive:evidence","path":".visual-hive/hive/wiki/visual-hive-regression.md","tags":["visual-hive"],"relatedEvidenceKeys":["selector.dashboard"],"artifacts":[".visual-hive/evidence-packet.json"]}]}',
      "utf8"
    );
    await writeFile(
      path.join(hiveRoot, "hive", "repair-work-orders.json"),
      '[{"id":"repair-1","actor":"quality","title":"token=abc123","objective":"Fix Visual Hive regression","sourceBeadIds":["vh-bead-1"],"evidenceKeys":["selector.dashboard"],"likelyFiles":["src/App.tsx"],"artifacts":[".visual-hive/report.json"],"reproductionCommands":["visual-hive run --ci"],"acceptanceCriteria":["Visual Hive verdict passes after repair."],"allowedActions":["edit_pr_branch"],"forbiddenActions":["decide_visual_hive_verdict"],"maxAttempts":1,"branchPrefix":"hive/visual-hive-","prOnly":true,"requireHumanReview":true,"rerunVisualHive":true}]',
      "utf8"
    );
    await writeFile(
      path.join(hiveRoot, "hive", "hive-agent-policy.json"),
      '{"schemaVersion":"visual-hive.hive-agent-policy.v1","mode":"repair_request","acmmLevel":4,"enabled":true,"externalCallsMade":0,"verdictAuthority":"visual_hive","hiveAuthority":"advisory_or_guarded_repair","repair":{"enabled":true,"prOnly":true,"maxAttempts":1,"requireHumanReview":true,"rerunVisualHive":true,"branchPrefix":"hive/visual-hive-"},"allowedActions":["read_sanitized_evidence"],"forbiddenActions":["decide_visual_hive_verdict"],"trustedWorkflowRequiredFor":["agent_repair_execution"],"finalValidation":{"required":true,"command":"visual-hive pipeline --mode pr --ci","passFailOwnedBy":"visual_hive_verdict_engine"}}',
      "utf8"
    );
    await writeFile(path.join(hiveRoot, "hive", "mode-comparison.json"), '{"schemaVersion":"visual-hive.hive-mode-comparison.v1","modes":[{"recommendedUse":"token=abc123"}]}', "utf8");
    await writeFile(path.join(hiveRoot, "hive", "guarded-repair-preview.json"), '{"schemaVersion":"visual-hive.hive-guarded-repair-preview.v1","readiness":{"blockedReasons":["token=abc123"]}}', "utf8");
    await writeFile(path.join(hiveRoot, "hive", "guarded-repair-preview.md"), "Guarded repair token=abc123", "utf8");
    await writeFile(path.join(hiveRoot, "hive", "repair-request-envelope.json"), '{"schemaVersion":"visual-hive.hive-repair-request-envelope.v1","readiness":{"blockedReasons":["token=abc123"]}}', "utf8");
    await writeFile(path.join(hiveRoot, "hive", "repair-request-envelope.md"), "Repair request token=abc123", "utf8");
    await writeFile(path.join(hiveRoot, "hive", "trusted-repair-consumer-summary.json"), '{"schemaVersion":"visual-hive.hive-trusted-repair-consumer-summary.v1","readiness":{"blockedReasons":["token=abc123"]}}', "utf8");
    await writeFile(path.join(hiveRoot, "hive", "trusted-repair-consumer-summary.md"), "Trusted repair consumer token=abc123", "utf8");
    await writeFile(path.join(hiveRoot, "hive", "trusted-repair-workflow-dry-run.json"), '{"schemaVersion":"visual-hive.hive-trusted-repair-workflow-dry-run.v1","readiness":{"blockedReasons":["token=abc123"]}}', "utf8");
    await writeFile(path.join(hiveRoot, "hive", "trusted-repair-workflow-dry-run.md"), "Trusted workflow token=abc123", "utf8");
    await writeFile(path.join(hiveRoot, "runbook.json"), '{"runbook":{"commands":[{"id":"doctor","command":"visual-hive doctor token=abc123"}]}}', "utf8");
    await writeFile(
      path.join(hiveRoot, "connections-portfolio.json"),
      '{"schemaVersion":1,"portfolio":{"queues":[{"id":"security_risks","connections":[]}]},"connections":[{"id":"repo","attention":["token=abc123"]}]}',
      "utf8"
    );
    await writeFile(
      path.join(hiveRoot, "schema-catalog.json"),
      '{"schemaVersion":"visual-hive.schema-catalog.v1","status":"passed","checks":[{"id":"schema-id","status":"passed","message":"token=abc123"}]}',
      "utf8"
    );
    await writeFile(path.join(hiveRoot, "artifacts-index.json"), '{"schemaVersion":1,"artifactCount":999}', "utf8");
    await writeFile(path.join(hiveRoot, "generated", "visual-hive.generated.spec.ts"), "test('dashboard', async () => {});", "utf8").catch(async () => {
      await mkdir(path.join(hiveRoot, "generated"), { recursive: true });
      await writeFile(path.join(hiveRoot, "generated", "visual-hive.generated.spec.ts"), "test('dashboard', async () => {});", "utf8");
    });
    await writeFile(path.join(hiveRoot, "artifacts", "screenshots", "dashboard.png"), "png-bytes", "utf8");

    const index = await indexArtifacts({
      repoRoot: tempRoot,
      project: "artifact-fixture",
      now: new Date("2026-06-15T00:00:00.000Z")
    });

    expect(index.summary.artifactCount).toBe(61);
    expect(index.artifacts.some((artifact) => artifact.path.endsWith("artifacts-index.json"))).toBe(false);
    expect(index.summary.image).toBe(1);
    expect(index.summary.redactedPreviews).toBeGreaterThanOrEqual(1);
    const prompt = index.artifacts.find((artifact) => artifact.path.endsWith("triage-prompt.md"));
    expect(prompt?.preview).toContain("[REDACTED]");
    expect(prompt?.labels).toContain("prompt");
    const canaryPlan = index.artifacts.find((artifact) => artifact.path.endsWith("plan.canary.json"));
    expect(canaryPlan?.labels).toContain("plan");
    expect(canaryPlan?.schemaPath).toBe("schemas/visual-hive.plan.schema.json");
    const planLaneSummary = index.artifacts.find((artifact) => artifact.path.endsWith("plans.json"));
    expect(planLaneSummary?.preview).toContain("[REDACTED]");
    expect(planLaneSummary?.labels).toContain("plan-lanes");
    expect(planLaneSummary?.labels).toContain("evidence-resource");
    expect(planLaneSummary?.schemaPath).toBe("schemas/visual-hive.plans.schema.json");
    expect(planLaneSummary).toMatchObject({
      evidenceResourceId: "plan-lanes",
      evidenceResourceUri: "visual-hive://plan-lanes",
      evidenceResourceTitle: "Plan Lanes",
      evidenceReadToolName: "visual_hive_read_plan_lanes"
    });
    const repoMap = index.artifacts.find((artifact) => artifact.path.endsWith("repo-map.json"));
    expect(repoMap?.preview).toContain("[REDACTED]");
    expect(repoMap?.labels).toContain("repo-map");
    expect(repoMap?.schemaPath).toBe("schemas/visual-hive.repo-map.schema.json");
    expect(repoMap).toMatchObject({
      evidenceResourceId: "repo-map",
      evidenceResourceUri: "visual-hive://repo-map",
      evidenceResourceTitle: "Repository Intelligence Map",
      evidenceReadToolName: "visual_hive_read_repo_map"
    });
    const repoContext = index.artifacts.find((artifact) => artifact.path.endsWith("repo-context.md"));
    expect(repoContext?.preview).toContain("[REDACTED]");
    expect(repoContext?.labels).toContain("repo-context");
    expect(repoContext).toMatchObject({
      evidenceResourceId: "repo-context",
      evidenceResourceUri: "visual-hive://repo-context",
      evidenceResourceTitle: "Repository Context Summary",
      evidenceReadToolName: "visual_hive_read_repo_context"
    });
    const testingLayers = index.artifacts.find((artifact) => artifact.path.endsWith("testing-layers.json"));
    expect(testingLayers?.preview).toContain("[REDACTED]");
    expect(testingLayers?.labels).toContain("testing-layers");
    expect(testingLayers?.schemaPath).toBe("schemas/visual-hive.testing-layers.schema.json");
    expect(testingLayers).toMatchObject({
      evidenceResourceId: "testing-layers",
      evidenceResourceUri: "visual-hive://testing-layers",
      evidenceResourceTitle: "Testing Layers",
      evidenceReadToolName: "visual_hive_read_testing_layers"
    });
    const testingLayersSummary = index.artifacts.find((artifact) => artifact.path.endsWith("testing-layers.md"));
    expect(testingLayersSummary?.preview).toContain("[REDACTED]");
    expect(testingLayersSummary?.labels).toContain("testing-layers-summary");
    const testCreationPlan = index.artifacts.find((artifact) => artifact.path.endsWith("test-creation-plan.json"));
    expect(testCreationPlan?.preview).toContain("[REDACTED]");
    expect(testCreationPlan?.labels).toContain("test-creation-plan");
    expect(testCreationPlan?.schemaPath).toBe("schemas/visual-hive.test-creation-plan.schema.json");
    expect(testCreationPlan).toMatchObject({
      evidenceResourceId: "test-creation-plan",
      evidenceResourceUri: "visual-hive://test-creation-plan",
      evidenceResourceTitle: "Test Creation Plan",
      evidenceReadToolName: "visual_hive_read_test_creation_plan"
    });
    const testCreationSummary = index.artifacts.find((artifact) => artifact.path.endsWith("test-creation-plan.md"));
    expect(testCreationSummary?.preview).toContain("[REDACTED]");
    expect(testCreationSummary?.labels).toContain("test-creation-summary");
    const verdict = index.artifacts.find((artifact) => artifact.path.endsWith("verdict.json"));
    expect(verdict?.preview).toContain("[REDACTED]");
    expect(verdict?.labels).toContain("verdict");
    expect(verdict?.schemaPath).toBe("schemas/visual-hive.verdict.schema.json");
    expect(verdict).toMatchObject({
      evidenceResourceId: "latest-verdict",
      evidenceResourceUri: "visual-hive://latest-verdict",
      evidenceResourceTitle: "Latest Visual Hive Verdict",
      evidenceReadToolName: "visual_hive_read_verdict"
    });
    const verdictSummary = index.artifacts.find((artifact) => artifact.path.endsWith("verdict.md"));
    expect(verdictSummary?.preview).toContain("[REDACTED]");
    expect(verdictSummary?.labels).toContain("verdict-summary");
    const setupPrPlan = index.artifacts.find((artifact) => artifact.path.endsWith("setup-pr-plan.json"));
    expect(setupPrPlan?.preview).toContain("[REDACTED]");
    expect(setupPrPlan?.labels).toContain("setup-pr-plan");
    expect(setupPrPlan?.schemaPath).toBe("schemas/visual-hive.setup-pr-plan.schema.json");
    expect(setupPrPlan).toMatchObject({
      evidenceResourceId: "setup-pr-plan",
      evidenceResourceUri: "visual-hive://setup-pr-plan",
      evidenceResourceTitle: "Setup Pull Request Plan",
      evidenceReadToolName: "visual_hive_read_setup_pr_plan"
    });
    const triageReport = index.artifacts.find((artifact) => artifact.path.endsWith("triage.json"));
    expect(triageReport?.preview).toContain("[REDACTED]");
    expect(triageReport?.labels).toContain("triage-report");
    expect(triageReport?.schemaPath).toBe("schemas/visual-hive.triage.schema.json");
    expect(triageReport?.schemaId).toBe("https://visual-hive.dev/schemas/visual-hive.triage.schema.json");
    const baselineReview = index.artifacts.find((artifact) => artifact.path.endsWith("baseline-review.md"));
    expect(baselineReview?.preview).toContain("[REDACTED]");
    expect(baselineReview?.labels).toContain("baseline-review");
    expect(baselineReview?.labels).toContain("prompt");
    const baselines = index.artifacts.find((artifact) => artifact.path.endsWith("baselines.json"));
    expect(baselines?.preview).toContain("[REDACTED]");
    expect(baselines?.labels).toContain("baseline-review");
    expect(baselines?.schemaPath).toBe("schemas/visual-hive.baselines.schema.json");
    expect(baselines).toMatchObject({
      evidenceResourceId: "baseline-review",
      evidenceResourceUri: "visual-hive://baseline-review",
      evidenceResourceTitle: "Baseline Review Queue",
      evidenceReadToolName: "visual_hive_read_baseline_review"
    });
    const runHistory = index.artifacts.find((artifact) => artifact.path.endsWith("history.json"));
    expect(runHistory?.preview).toContain("[REDACTED]");
    expect(runHistory?.labels).toContain("history");
    expect(runHistory?.labels).toContain("evidence-resource");
    expect(runHistory?.schemaPath).toBe("schemas/visual-hive.history.schema.json");
    expect(runHistory).toMatchObject({
      evidenceResourceId: "run-history",
      evidenceResourceUri: "visual-hive://run-history",
      evidenceResourceTitle: "Run History",
      evidenceReadToolName: "visual_hive_read_run_history"
    });
    const baselineApprovals = index.artifacts.find((artifact) => artifact.path.endsWith("baseline-approvals.json"));
    expect(baselineApprovals?.preview).toContain("[REDACTED]");
    expect(baselineApprovals?.labels).toContain("baseline-approvals");
    expect(baselineApprovals?.schemaPath).toBe("schemas/visual-hive.baseline-approvals.schema.json");
    expect(baselineApprovals).toMatchObject({
      evidenceResourceId: "baseline-approvals",
      evidenceResourceUri: "visual-hive://baseline-approvals",
      evidenceResourceTitle: "Baseline Approval Log",
      evidenceReadToolName: "visual_hive_read_baseline_approvals"
    });
    const baselineRejections = index.artifacts.find((artifact) => artifact.path.endsWith("baseline-rejections.json"));
    expect(baselineRejections?.preview).toContain("[REDACTED]");
    expect(baselineRejections?.labels).toContain("baseline-rejections");
    expect(baselineRejections?.schemaPath).toBe("schemas/visual-hive.baseline-rejections.schema.json");
    expect(baselineRejections).toMatchObject({
      evidenceResourceId: "baseline-rejections",
      evidenceResourceUri: "visual-hive://baseline-rejections",
      evidenceResourceTitle: "Baseline Rejection Log",
      evidenceReadToolName: "visual_hive_read_baseline_rejections"
    });
    const comment = index.artifacts.find((artifact) => artifact.path.endsWith("pr-comment.md"));
    expect(comment?.preview).toContain("[REDACTED]");
    expect(comment?.labels).toContain("pr-comment");
    const actions = index.artifacts.find((artifact) => artifact.path.endsWith("control-plane-actions.json"));
    expect(actions?.preview).toContain("[REDACTED]");
    expect(actions?.labels).toContain("control-plane-actions");
    const coverageRecommendations = index.artifacts.find((artifact) => artifact.path.endsWith("coverage-recommendations.json"));
    expect(coverageRecommendations?.preview).toContain("[REDACTED]");
    expect(coverageRecommendations?.labels).toContain("coverage-recommendations");
    expect(coverageRecommendations?.labels).not.toContain("setup-recommendations");
    expect(coverageRecommendations?.schemaPath).toBe("schemas/visual-hive.coverage-recommendations.schema.json");
    expect(coverageRecommendations).toMatchObject({
      evidenceResourceId: "coverage-recommendations",
      evidenceResourceUri: "visual-hive://coverage-recommendations",
      evidenceResourceTitle: "Coverage Recommendations",
      evidenceReadToolName: "visual_hive_read_coverage_recommendations"
    });
    const flowAudit = index.artifacts.find((artifact) => path.basename(artifact.path) === "flows.json");
    expect(flowAudit?.preview).toContain("[REDACTED]");
    expect(flowAudit?.labels).toContain("flow-audit");
    expect(flowAudit?.schemaPath).toBe("schemas/visual-hive.flows.schema.json");
    const workflowAudit = index.artifacts.find((artifact) => path.basename(artifact.path) === "workflows.json");
    expect(workflowAudit?.preview).toContain("[REDACTED]");
    expect(workflowAudit?.labels).toContain("workflow-audit");
    expect(workflowAudit?.schemaPath).toBe("schemas/visual-hive.workflows.schema.json");
    expect(workflowAudit).toMatchObject({
      evidenceResourceId: "workflow-audit",
      evidenceResourceUri: "visual-hive://workflow-audit",
      evidenceResourceTitle: "Workflow Audit",
      evidenceReadToolName: "visual_hive_read_workflow_audit"
    });
    const securityAudit = index.artifacts.find((artifact) => artifact.path.endsWith("security.json"));
    expect(securityAudit?.preview).toContain("[REDACTED]");
    expect(securityAudit?.labels).toContain("security-audit");
    const costAudit = index.artifacts.find((artifact) => artifact.path.endsWith("costs.json"));
    expect(costAudit?.preview).toContain("[REDACTED]");
    expect(costAudit?.labels).toContain("cost-audit");
    const readinessGate = index.artifacts.find((artifact) => artifact.path.endsWith("readiness.json"));
    expect(readinessGate?.preview).toContain("[REDACTED]");
    expect(readinessGate?.labels).toContain("readiness-gate");
    expect(readinessGate?.schemaPath).toBe("schemas/visual-hive.readiness.schema.json");
    expect(readinessGate).toMatchObject({
      evidenceResourceId: "readiness-gate",
      evidenceResourceUri: "visual-hive://readiness-gate",
      evidenceResourceTitle: "Readiness Gate",
      evidenceReadToolName: "visual_hive_read_readiness_gate"
    });
    const providerDecisions = index.artifacts.find((artifact) => artifact.path.endsWith("provider-decisions.json"));
    expect(providerDecisions?.preview).toContain("[REDACTED]");
    expect(providerDecisions?.labels).toContain("provider-decisions");
    expect(providerDecisions?.schemaPath).toBe("schemas/visual-hive.provider-decisions.schema.json");
    const providerSetupPlan = index.artifacts.find((artifact) => artifact.path.endsWith("provider-setup-plan.json"));
    expect(providerSetupPlan?.preview).toContain("[REDACTED]");
    expect(providerSetupPlan?.labels).toContain("provider-setup-plan");
    expect(providerSetupPlan?.schemaPath).toBe("schemas/visual-hive.provider-setup-plan.schema.json");
    const providerHandoff = index.artifacts.find((artifact) => artifact.path.endsWith("provider-handoff.json"));
    expect(providerHandoff?.preview).toContain("[REDACTED]");
    expect(providerHandoff?.labels).toContain("provider-handoff");
    expect(providerHandoff?.schemaPath).toBe("schemas/visual-hive.provider-handoff.schema.json");
    const providerUpload = index.artifacts.find((artifact) => artifact.path.endsWith("provider-upload/argos/manifest.json"));
    expect(providerUpload?.preview).toContain("[REDACTED]");
    expect(providerUpload?.labels).toContain("provider-upload");
    expect(providerUpload?.labels).toContain("provider-upload-argos-manifest");
    expect(providerUpload?.labels).toContain("evidence-resource");
    expect(providerUpload?.schemaPath).toBe("schemas/visual-hive.provider-upload.schema.json");
    expect(providerUpload).toMatchObject({
      evidenceResourceId: "provider-upload-argos-manifest",
      evidenceResourceUri: "visual-hive://provider-upload/argos/manifest",
      evidenceResourceTitle: "Argos Provider Upload Manifest",
      evidenceReadToolName: "visual_hive_read_provider_upload_manifest"
    });
    for (const artifact of index.artifacts.filter((candidate) => candidate.schemaPath)) {
      await expect(readFile(path.join(repoRoot, artifact.schemaPath!), "utf8"), artifact.path).resolves.toContain("$schema");
    }
    const llmDecisions = index.artifacts.find((artifact) => artifact.path.endsWith("llm-decisions.json"));
    expect(llmDecisions?.preview).toContain("[REDACTED]");
    expect(llmDecisions?.labels).toContain("llm-decisions");
    expect(llmDecisions?.schemaPath).toBe("schemas/visual-hive.llm-decisions.schema.json");
    const agentPacket = index.artifacts.find((artifact) => artifact.path.endsWith("agent-packet.json"));
    expect(agentPacket?.preview).toContain("[REDACTED]");
    expect(agentPacket?.labels).toContain("agent-packet");
    expect(agentPacket?.labels).toContain("evidence-resource");
    expect(agentPacket?.schemaPath).toBe("schemas/visual-hive.agent-packet.schema.json");
    expect(agentPacket).toMatchObject({
      evidenceResourceId: "agent-packet",
      evidenceResourceUri: "visual-hive://agent-packet",
      evidenceReadToolName: "visual_hive_read_agent_packet"
    });
    const providerAgentPacket = index.artifacts.find((artifact) => artifact.path.endsWith("provider-agent-packet.json"));
    expect(providerAgentPacket?.preview).toContain("[REDACTED]");
    expect(providerAgentPacket?.labels).toContain("agent-packet");
    expect(providerAgentPacket?.labels).toContain("provider-agent-packet");
    expect(providerAgentPacket?.labels).toContain("evidence-resource");
    expect(providerAgentPacket?.schemaPath).toBe("schemas/visual-hive.agent-packet.schema.json");
    expect(providerAgentPacket).toMatchObject({
      evidenceResourceId: "provider-agent-packet",
      evidenceResourceUri: "visual-hive://provider-agent-packet",
      evidenceReadToolName: "visual_hive_read_provider_agent_packet"
    });
    const handoffAgentPacket = index.artifacts.find((artifact) => artifact.path.endsWith("handoff-agent-packet.json"));
    expect(handoffAgentPacket?.preview).toContain("[REDACTED]");
    expect(handoffAgentPacket?.labels).toContain("agent-packet");
    expect(handoffAgentPacket?.labels).toContain("handoff-agent-packet");
    expect(handoffAgentPacket?.schemaPath).toBe("schemas/visual-hive.agent-packet.schema.json");
    const toolRegistry = index.artifacts.find((artifact) => artifact.path.endsWith("tool-registry.json"));
    expect(toolRegistry?.preview).toContain("[REDACTED]");
    expect(toolRegistry?.labels).toContain("tool-registry");
    expect(toolRegistry?.labels).toContain("evidence-resource");
    expect(toolRegistry?.schemaPath).toBe("schemas/visual-hive.tool-registry.schema.json");
    expect(toolRegistry).toMatchObject({
      evidenceResourceId: "tool-registry",
      evidenceResourceUri: "visual-hive://tool-registry",
      evidenceReadToolName: "visual_hive_read_tool_registry"
    });
    const toolCards = index.artifacts.find((artifact) => artifact.path.endsWith("tool-cards.md"));
    expect(toolCards?.preview).toContain("[REDACTED]");
    expect(toolCards?.labels).toContain("tool-cards");
    const mcpManifest = index.artifacts.find((artifact) => artifact.path.endsWith("mcp-manifest.json"));
    expect(mcpManifest?.preview).toContain("[REDACTED]");
    expect(mcpManifest?.labels).toContain("mcp-manifest");
    expect(mcpManifest?.schemaPath).toBe("schemas/visual-hive.mcp.schema.json");
    expect(mcpManifest).toMatchObject({
      evidenceResourceId: "mcp-manifest",
      evidenceResourceUri: "visual-hive://mcp-manifest",
      evidenceResourceTitle: "MCP Manifest",
      evidenceReadToolName: "visual_hive_read_mcp_manifest"
    });
    const contextLedger = index.artifacts.find((artifact) => artifact.path.endsWith("context-ledger.json"));
    expect(contextLedger?.preview).toContain("[REDACTED]");
    expect(contextLedger?.preview).toContain("evidenceResources");
    expect(contextLedger?.preview).toContain("visual_hive_read_missing_tests");
    expect(contextLedger?.labels).toContain("context-ledger");
    expect(contextLedger?.schemaPath).toBe("schemas/visual-hive.context-ledger.schema.json");
    const pipelineStatus = index.artifacts.find((artifact) => artifact.path.endsWith("pipeline.json"));
    expect(pipelineStatus?.preview).toContain("[REDACTED]");
    expect(pipelineStatus?.labels).toContain("pipeline-status");
    expect(pipelineStatus?.labels).toContain("evidence-resource");
    expect(pipelineStatus?.schemaPath).toBe("schemas/visual-hive.pipeline.schema.json");
    expect(pipelineStatus).toMatchObject({
      evidenceResourceId: "pipeline-status",
      evidenceResourceUri: "visual-hive://pipeline-status",
      evidenceResourceTitle: "Pipeline Status",
      evidenceReadToolName: "visual_hive_read_pipeline_status"
    });
    const schemaCatalog = index.artifacts.find((artifact) => artifact.path.endsWith("schema-catalog.json"));
    expect(schemaCatalog?.preview).toContain("[REDACTED]");
    expect(schemaCatalog?.labels).toContain("schema-catalog");
    expect(schemaCatalog?.labels).toContain("evidence-resource");
    expect(schemaCatalog?.schemaPath).toBe("schemas/visual-hive.schema-catalog.schema.json");
    expect(schemaCatalog).toMatchObject({
      evidenceResourceId: "schema-catalog",
      evidenceResourceUri: "visual-hive://schema-catalog",
      evidenceResourceTitle: "Schema Catalog Verification",
      evidenceReadToolName: "visual_hive_read_schema_catalog"
    });
    for (const artifact of index.artifacts.filter((candidate) => candidate.evidenceResourceId)) {
      expect(artifact.labels).toContain("evidence-resource");
      expect(artifact.labels).toContain(artifact.evidenceResourceId);
    }
    const handoffValidation = index.artifacts.find((artifact) => artifact.path.endsWith("hive-handoff-validation.json"));
    expect(handoffValidation?.preview).toContain("[REDACTED]");
    expect(handoffValidation?.labels).toContain("hive-handoff-validation");
    expect(handoffValidation?.schemaPath).toBe("schemas/visual-hive.handoff-validation.schema.json");
    const hiveBeads = index.artifacts.find((artifact) => artifact.path.endsWith("hive/beads.json"));
    expect(hiveBeads?.preview).toContain("[REDACTED]");
    expect(hiveBeads?.labels).toContain("hive-beads");
    expect(hiveBeads?.schemaPath).toBe("schemas/visual-hive.hive-beads.schema.json");
    expect(hiveBeads).toMatchObject({
      evidenceResourceId: "hive-beads",
      evidenceResourceUri: "visual-hive://hive-beads",
      evidenceResourceTitle: "Hive Beads",
      evidenceReadToolName: "visual_hive_read_hive_beads"
    });
    const hiveKnowledgeFacts = index.artifacts.find((artifact) => artifact.path.endsWith("hive/knowledge-facts.json"));
    expect(hiveKnowledgeFacts?.preview).toContain("[REDACTED]");
    expect(hiveKnowledgeFacts?.labels).toContain("hive-knowledge");
    expect(hiveKnowledgeFacts?.schemaPath).toBe("schemas/visual-hive.hive-knowledge-facts.schema.json");
    expect(hiveKnowledgeFacts).toMatchObject({
      evidenceResourceId: "hive-knowledge-facts",
      evidenceResourceUri: "visual-hive://hive/knowledge-facts",
      evidenceResourceTitle: "Hive Knowledge Facts",
      evidenceReadToolName: "visual_hive_read_hive_knowledge_facts"
    });
    const hiveKnowledgeGraph = index.artifacts.find((artifact) => artifact.path.endsWith("hive/knowledge-graph.json"));
    expect(hiveKnowledgeGraph?.preview).toContain("[REDACTED]");
    expect(hiveKnowledgeGraph?.labels).toContain("hive-graph");
    expect(hiveKnowledgeGraph?.schemaPath).toBe("schemas/visual-hive.hive-knowledge-graph.schema.json");
    expect(hiveKnowledgeGraph).toMatchObject({
      evidenceResourceId: "hive-knowledge-graph",
      evidenceResourceUri: "visual-hive://hive/knowledge-graph",
      evidenceResourceTitle: "Hive Knowledge Graph",
      evidenceReadToolName: "visual_hive_read_hive_knowledge_graph"
    });
    const hiveWikiIndex = index.artifacts.find((artifact) => artifact.path.endsWith("hive/wiki-index.json"));
    expect(hiveWikiIndex?.preview).toContain("[REDACTED]");
    expect(hiveWikiIndex?.labels).toContain("hive-wiki-index");
    expect(hiveWikiIndex?.schemaPath).toBe("schemas/visual-hive.hive-wiki-index.schema.json");
    expect(hiveWikiIndex).toMatchObject({
      evidenceResourceId: "hive-wiki-index",
      evidenceResourceUri: "visual-hive://hive/wiki-index",
      evidenceResourceTitle: "Hive Wiki Index",
      evidenceReadToolName: "visual_hive_read_hive_wiki_index"
    });
    const hiveRepairWorkOrders = index.artifacts.find((artifact) => artifact.path.endsWith("hive/repair-work-orders.json"));
    expect(hiveRepairWorkOrders?.preview).toContain("[REDACTED]");
    expect(hiveRepairWorkOrders?.labels).toContain("hive-repair");
    expect(hiveRepairWorkOrders?.schemaPath).toBe("schemas/visual-hive.hive-repair-work-orders.schema.json");
    expect(hiveRepairWorkOrders).toMatchObject({
      evidenceResourceId: "hive-repair-work-orders",
      evidenceResourceUri: "visual-hive://hive/repair-work-orders",
      evidenceResourceTitle: "Hive Repair Work Orders",
      evidenceReadToolName: "visual_hive_read_hive_repair_work_orders"
    });
    const hiveAgentPolicy = index.artifacts.find((artifact) => artifact.path.endsWith("hive/hive-agent-policy.json"));
    expect(hiveAgentPolicy?.schemaPath).toBe("schemas/visual-hive.hive-agent-policy.schema.json");
    expect(hiveAgentPolicy?.labels).toContain("hive-agent-policy");
    expect(hiveAgentPolicy).toMatchObject({
      evidenceResourceId: "hive-agent-policy",
      evidenceResourceUri: "visual-hive://hive/agent-policy",
      evidenceResourceTitle: "Hive Agent Policy",
      evidenceReadToolName: "visual_hive_read_hive_agent_policy"
    });
    const hiveModeComparison = index.artifacts.find((artifact) => artifact.path.endsWith("mode-comparison.json"));
    expect(hiveModeComparison?.preview).toContain("[REDACTED]");
    expect(hiveModeComparison?.labels).toContain("hive-mode-comparison");
    expect(hiveModeComparison?.schemaPath).toBe("schemas/visual-hive.hive-mode-comparison.schema.json");
    const guardedRepairPreview = index.artifacts.find((artifact) => artifact.path.endsWith("guarded-repair-preview.json"));
    expect(guardedRepairPreview?.preview).toContain("[REDACTED]");
    expect(guardedRepairPreview?.labels).toContain("hive-guarded-repair-preview");
    expect(guardedRepairPreview?.schemaPath).toBe("schemas/visual-hive.hive-guarded-repair-preview.schema.json");
    const guardedRepairPreviewMarkdown = index.artifacts.find((artifact) => artifact.path.endsWith("guarded-repair-preview.md"));
    expect(guardedRepairPreviewMarkdown?.preview).toContain("[REDACTED]");
    expect(guardedRepairPreviewMarkdown?.labels).toContain("hive-guarded-repair-preview");
    const repairRequestEnvelope = index.artifacts.find((artifact) => artifact.path.endsWith("repair-request-envelope.json"));
    expect(repairRequestEnvelope?.preview).toContain("[REDACTED]");
    expect(repairRequestEnvelope?.labels).toContain("hive-repair-request-envelope");
    expect(repairRequestEnvelope?.schemaPath).toBe("schemas/visual-hive.hive-repair-request-envelope.schema.json");
    const repairRequestEnvelopeMarkdown = index.artifacts.find((artifact) => artifact.path.endsWith("repair-request-envelope.md"));
    expect(repairRequestEnvelopeMarkdown?.preview).toContain("[REDACTED]");
    expect(repairRequestEnvelopeMarkdown?.labels).toContain("hive-repair-request-envelope");
    const trustedRepairConsumerSummary = index.artifacts.find((artifact) => artifact.path.endsWith("trusted-repair-consumer-summary.json"));
    expect(trustedRepairConsumerSummary?.preview).toContain("[REDACTED]");
    expect(trustedRepairConsumerSummary?.labels).toContain("hive-trusted-repair-consumer-summary");
    expect(trustedRepairConsumerSummary?.schemaPath).toBe("schemas/visual-hive.hive-trusted-repair-consumer-summary.schema.json");
    const trustedRepairConsumerSummaryMarkdown = index.artifacts.find((artifact) => artifact.path.endsWith("trusted-repair-consumer-summary.md"));
    expect(trustedRepairConsumerSummaryMarkdown?.preview).toContain("[REDACTED]");
    expect(trustedRepairConsumerSummaryMarkdown?.labels).toContain("hive-trusted-repair-consumer-summary");
    const trustedRepairWorkflowDryRun = index.artifacts.find((artifact) => artifact.path.endsWith("trusted-repair-workflow-dry-run.json"));
    expect(trustedRepairWorkflowDryRun?.preview).toContain("[REDACTED]");
    expect(trustedRepairWorkflowDryRun?.labels).toContain("hive-trusted-repair-workflow-dry-run");
    expect(trustedRepairWorkflowDryRun?.schemaPath).toBe("schemas/visual-hive.hive-trusted-repair-workflow-dry-run.schema.json");
    const trustedRepairWorkflowDryRunMarkdown = index.artifacts.find((artifact) => artifact.path.endsWith("trusted-repair-workflow-dry-run.md"));
    expect(trustedRepairWorkflowDryRunMarkdown?.preview).toContain("[REDACTED]");
    expect(trustedRepairWorkflowDryRunMarkdown?.labels).toContain("hive-trusted-repair-workflow-dry-run");
    const runbook = index.artifacts.find((artifact) => artifact.path.endsWith("runbook.json"));
    expect(runbook?.preview).toContain("[REDACTED]");
    expect(runbook?.labels).toContain("runbook");
    expect(runbook?.schemaPath).toBe("schemas/visual-hive.runbook.schema.json");
    const connectionsPortfolio = index.artifacts.find((artifact) => artifact.path.endsWith("connections-portfolio.json"));
    expect(connectionsPortfolio?.preview).toContain("[REDACTED]");
    expect(connectionsPortfolio?.labels).toContain("connections-portfolio");
    expect(connectionsPortfolio?.schemaPath).toBe("schemas/visual-hive.connections-portfolio.schema.json");
    const spec = index.artifacts.find((artifact) => artifact.kind === "typescript");
    expect(spec?.labels).toContain("generated-spec");
  });

  it("keeps artifact evidence-resource schema enums aligned with the core catalog", async () => {
    type StringEnumProperty = { enum?: string[] };
    type ArtifactSchema = {
      properties?: {
        artifacts?: {
          items?: {
            properties?: Record<string, StringEnumProperty>;
          };
        };
      };
    };

    const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.artifacts.schema.json"), "utf8")) as ArtifactSchema;
    const artifactProperties = schema.properties?.artifacts?.items?.properties ?? {};

    expect(artifactProperties.evidenceResourceId?.enum).toEqual(VISUAL_HIVE_EVIDENCE_RESOURCES.map((resource) => resource.id));
    expect(artifactProperties.evidenceResourceUri?.enum).toEqual(VISUAL_HIVE_EVIDENCE_RESOURCES.map((resource) => resource.uri));
    expect(artifactProperties.evidenceReadToolName?.enum).toEqual(
      VISUAL_HIVE_EVIDENCE_RESOURCES.flatMap((resource) => (resource.readTool ? [resource.readTool.name] : []))
    );
  });

  it("verifies checked-in schema catalog metadata against the evidence-resource catalog", async () => {
    const report = await verifySchemaCatalog({ rootDir: repoRoot, now: new Date("2026-06-15T00:00:00.000Z") });

    expect(report.schemaVersion).toBe("visual-hive.schema-catalog.v1");
    expect(report.status).toBe("passed");
    expect(report.summary.failed).toBe(0);
    expect(report.summary.evidenceResources).toBe(VISUAL_HIVE_EVIDENCE_RESOURCES.length);
    expect(report.summary.evidenceReadTools).toBe(VISUAL_HIVE_EVIDENCE_RESOURCES.filter((resource) => resource.readTool).length);
    expect(report.checks.find((check) => check.id.includes("visual-hive.agent-packet.schema.json") && check.id.includes("evidenceResourceId"))).toMatchObject({
      status: "passed"
    });
  });

  it("reports schema catalog drift with exact expected and actual enums", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-schema-drift-"));
    tempDirs.push(tempRoot);
    await mkdir(path.join(tempRoot, "schemas"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "schemas", "visual-hive.bad.schema.json"),
      JSON.stringify(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "https://visual-hive.dev/schemas/visual-hive.bad.schema.json",
          type: "object",
          properties: {
            evidenceResourceId: { type: "string", enum: ["stale-resource"] }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const report = await verifySchemaCatalog({ rootDir: tempRoot, now: new Date("2026-06-15T00:00:00.000Z") });
    const drift = report.checks.find((check) => check.id.includes("evidenceResourceId.enum"));

    expect(report.status).toBe("failed");
    expect(drift).toMatchObject({
      status: "failed",
      actual: ["stale-resource"],
      expected: VISUAL_HIVE_EVIDENCE_RESOURCES.map((resource) => resource.id)
    });
  });

  it("refuses to index artifact roots outside the repo", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-artifacts-escape-"));
    tempDirs.push(tempRoot);
    await expect(indexArtifacts({ repoRoot: tempRoot, hiveRoot: path.dirname(tempRoot) })).rejects.toThrow(/outside repository root/);
  });

  it("prioritizes current artifacts over history when the artifact cap is reached", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-artifacts-priority-"));
    tempDirs.push(tempRoot);
    const hiveRoot = path.join(tempRoot, ".visual-hive");
    await mkdir(path.join(hiveRoot, "history", "old"), { recursive: true });
    await writeFile(path.join(hiveRoot, "report.json"), '{"schemaVersion":2,"status":"passed"}', "utf8");
    await writeFile(path.join(hiveRoot, "generated", "visual-hive.generated.spec.ts"), "test('current', async () => {});", "utf8").catch(async () => {
      await mkdir(path.join(hiveRoot, "generated"), { recursive: true });
      await writeFile(path.join(hiveRoot, "generated", "visual-hive.generated.spec.ts"), "test('current', async () => {});", "utf8");
    });
    for (let index = 0; index < 8; index += 1) {
      await writeFile(path.join(hiveRoot, "history", "old", `${index}.json`), `{"index":${index}}`, "utf8");
    }

    const artifactIndex = await indexArtifacts({ repoRoot: tempRoot, maxArtifacts: 3 });
    const paths = artifactIndex.artifacts.map((artifact) => artifact.path);

    expect(paths).toContain(".visual-hive/report.json");
    expect(paths).toContain(".visual-hive/generated/visual-hive.generated.spec.ts");
    expect(paths.some((artifactPath) => artifactPath.includes(".visual-hive/history/old/"))).toBe(false);
    expect(artifactIndex.warnings.join(" ")).toContain("Skipped 1 run history directory");
  });

  it("preserves catalog-backed evidence resources when the artifact cap is reached", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-artifacts-evidence-priority-"));
    tempDirs.push(tempRoot);
    const hiveRoot = path.join(tempRoot, ".visual-hive");
    await mkdir(path.join(hiveRoot, "artifacts", "screenshots"), { recursive: true });
    await writeFile(
      path.join(hiveRoot, "schema-catalog.json"),
      '{"schemaVersion":"visual-hive.schema-catalog.v1","status":"passed","summary":{"failed":0},"checks":[]}',
      "utf8"
    );
    await writeFile(path.join(hiveRoot, "report.json"), '{"schemaVersion":2,"status":"passed"}', "utf8");
    for (let index = 0; index < 20; index += 1) {
      await writeFile(path.join(hiveRoot, "artifacts", "screenshots", `aaa-${index}.png`), "png-bytes", "utf8");
    }

    const artifactIndex = await indexArtifacts({ repoRoot: tempRoot, maxArtifacts: 3 });
    const schemaCatalog = artifactIndex.artifacts.find((artifact) => artifact.path === ".visual-hive/schema-catalog.json");
    const report = artifactIndex.artifacts.find((artifact) => artifact.path === ".visual-hive/report.json");

    expect(schemaCatalog).toMatchObject({
      evidenceResourceId: "schema-catalog",
      evidenceResourceUri: "visual-hive://schema-catalog",
      evidenceReadToolName: "visual_hive_read_schema_catalog"
    });
    expect(report).toMatchObject({
      evidenceResourceId: "latest-report",
      evidenceResourceUri: "visual-hive://latest-report",
      evidenceReadToolName: "visual_hive_read_latest_report"
    });
    expect(artifactIndex.warnings.join(" ")).toContain("maxArtifacts=3");
  });

  it("indexes bundle manifests without treating copied payloads as current evidence", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-artifacts-bundle-"));
    tempDirs.push(tempRoot);
    const hiveRoot = path.join(tempRoot, ".visual-hive");
    await mkdir(path.join(hiveRoot, "hive"), { recursive: true });
    await mkdir(path.join(hiveRoot, "bundles", "proof-1", "files", ".visual-hive", "hive"), { recursive: true });
    await writeFile(path.join(hiveRoot, "hive", "hive-agent-policy.json"), '{"schemaVersion":"visual-hive.hive-agent-policy.v1"}', "utf8");
    await writeFile(path.join(hiveRoot, "bundles", "proof-1", "manifest.json"), '{"schemaVersion":"visual-hive.bundle.v1"}', "utf8");
    await writeFile(path.join(hiveRoot, "bundles", "proof-1", "files", ".visual-hive", "hive", "hive-agent-policy.json"), '{"copied":true}', "utf8");

    const artifactIndex = await indexArtifacts({ repoRoot: tempRoot });
    const paths = artifactIndex.artifacts.map((artifact) => artifact.path);

    expect(paths).toContain(".visual-hive/hive/hive-agent-policy.json");
    expect(paths).toContain(".visual-hive/bundles/proof-1/manifest.json");
    expect(paths).not.toContain(".visual-hive/bundles/proof-1/files/.visual-hive/hive/hive-agent-policy.json");
  });

  it("sanitizes absolute local paths in artifact previews", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-artifacts-sanitize-"));
    tempDirs.push(tempRoot);
    const hiveRoot = path.join(tempRoot, ".visual-hive");
    await mkdir(hiveRoot, { recursive: true });
    const insideReportPath = path.join(hiveRoot, "report.json");
    await writeFile(
      insideReportPath,
      JSON.stringify(
        {
          schemaVersion: 2,
          status: "failed",
          generatedSpecPath: insideReportPath,
          windowsExternalPath: "C:\\Users\\david\\OneDrive\\Documents\\secret\\debug.log",
          windowsSlashExternalPath: "C:/Users/david/OneDrive/Documents/secret/debug.log",
          posixExternalPath: "/home/david/private/token.txt",
          macExternalPath: "/Users/david/private/token.txt",
          pathDerivedNodeId: "baseline:C__Users_david_OneDrive_Documents_visual-hive-demo-site_.visual-hive_snapshots_dashboard.png"
        },
        null,
        2
      ),
      "utf8"
    );

    const artifactIndex = await indexArtifacts({ repoRoot: tempRoot });
    const report = artifactIndex.artifacts.find((artifact) => artifact.path === ".visual-hive/report.json");

    expect(report?.preview).toContain(".visual-hive/report.json");
    expect(report?.preview).toContain("[redacted-external-path]/debug.log");
    expect(report?.preview).toContain("[redacted-external-path]/token.txt");
    expect(report?.preview).toContain("[redacted-local-path-slug]");
    expect(report?.preview).not.toContain("C:\\Users");
    expect(report?.preview).not.toContain("C:/Users");
    expect(report?.preview).not.toContain("OneDrive");
    expect(report?.preview).not.toContain("/home/david");
    expect(report?.preview).not.toContain("/Users/david");
    expect(report?.previewRedacted).toBe(true);
  });

  it("labels setup recommendation artifacts", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-artifacts-recommend-"));
    tempDirs.push(tempRoot);
    await writeJson(path.join(tempRoot, ".visual-hive", "recommendations.json"), { schemaVersion: 1 });

    const index = await indexArtifacts({ repoRoot: tempRoot });

    const setupRecommendations = index.artifacts.find((artifact) => artifact.path.endsWith("recommendations.json"));
    expect(setupRecommendations?.labels).toContain("setup-recommendations");
    expect(setupRecommendations).toMatchObject({
      evidenceResourceId: "setup-recommendations",
      evidenceResourceUri: "visual-hive://setup-recommendations",
      evidenceResourceTitle: "Setup Recommendations",
      evidenceReadToolName: "visual_hive_read_setup_recommendations"
    });
  });
});

describe("setup recommendations", () => {
  it("detects a React/Vite repo and emits a validated starter config", async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-recommend-"));
    tempDirs.push(targetRoot);
    await writeJson(path.join(targetRoot, "package.json"), {
      name: "sample-dashboard",
      scripts: {
        build: "vite build",
        preview: "vite preview",
        "test:e2e": "playwright test"
      },
      dependencies: {
        react: "^19.0.0",
        vite: "^6.0.0"
      },
      devDependencies: {
        "@playwright/test": "^1.50.0"
      }
    });
    await mkdir(path.join(targetRoot, "src"), { recursive: true });
    await mkdir(path.join(targetRoot, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(targetRoot, "src", "App.tsx"),
      `<main data-testid="dashboard-page"><a href="/clusters">Clusters</a><a href="/settings">Settings</a><Route path="/workloads" /></main>`,
      "utf8"
    );
    await writeFile(path.join(targetRoot, "playwright.config.ts"), `export default {};`, "utf8");
    await writeFile(
      path.join(targetRoot, ".github", "workflows", "ci.yml"),
      `name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`,
      "utf8"
    );
    await writeFile(
      path.join(targetRoot, ".github", "workflows", "legacy.yml"),
      `name: Legacy privileged
on:
  pull_request_target:
permissions:
  contents: write
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.LEGACY_TOKEN }}
`,
      "utf8"
    );

    const recommendation = await recommendSetup({ repoRoot: targetRoot, now: new Date("2026-06-15T00:00:00.000Z") });
    const parsedYaml = VisualHiveConfigSchema.parse(parseYaml(recommendation.recommendedConfigYaml));

    expect(recommendation.outputResource).toEqual({
      artifactPath: ".visual-hive/recommendations.json",
      evidenceResourceId: "setup-recommendations",
      evidenceResourceUri: "visual-hive://setup-recommendations",
      evidenceResourceTitle: "Setup Recommendations",
      evidenceResourceDescription: "No-network setup recommendation evidence for configuring Visual Hive safely in a repository.",
      evidenceReadToolName: "visual_hive_read_setup_recommendations"
    });
    expect(recommendation.project.type).toBe("react-vite");
    expect(recommendation.setupProfile).toBe("free-local");
    expect(recommendation.recommendedTarget.kind).toBe("command");
    expect(recommendation.recommendedTarget.serve).toBe("npm run preview -- --port 4173 --strictPort");
    expect(recommendation.recommendedContracts[0]?.selectors).toContain("[data-testid='dashboard-page']");
    expect(recommendation.recommendedContracts[0]?.steps[0]).toMatchObject({ action: "assertVisible", selector: "[data-testid='dashboard-page']" });
    expect(recommendation.recommendedContracts.map((contract) => contract.id)).toEqual([
      "app-shell-visual-stability",
      "route-clusters-visual-stability",
      "route-settings-visual-stability",
      "route-workloads-visual-stability"
    ]);
    expect(recommendation.recommendedContracts.find((contract) => contract.id === "route-clusters-visual-stability")).toMatchObject({
      targetId: "localPreview",
      screenshots: [{ name: "clusters-desktop", route: "/clusters", viewport: "desktop" }],
      steps: [
        { action: "goto", route: "/clusters" },
        { action: "assertVisible", selector: "[data-testid='dashboard-page']" }
      ]
    });
    expect(recommendation.costEstimate).toMatchObject({
      localScreenshotsPerRun: 5,
      externalScreenshotsPerRun: 0,
      estimatedMonthlyExternalScreenshots: 0
    });
    expect(recommendation.permissions.pullRequest.secretsRequired).toEqual([]);
    expect(recommendation.providerRecommendations.find((provider) => provider.providerId === "playwright")).toMatchObject({
      recommendation: "use",
      externalUploadAllowedByDefault: false
    });
    expect(recommendation.providerRecommendations.find((provider) => provider.providerId === "argos")).toMatchObject({
      recommendation: "future",
      requiredEnv: ["ARGOS_TOKEN"]
    });
    expect(recommendation.playwright).toMatchObject({
      status: "present",
      dependencies: ["@playwright/test"],
      scripts: ["test:e2e: playwright test"],
      configFiles: ["playwright.config.ts"]
    });
    expect(recommendation.detectedRoutes.map((route) => route.route)).toEqual(["/clusters", "/settings", "/workloads"]);
    expect(recommendation.onboardingChecklist.find((item) => item.id === "inspect-repository")?.evidence).toContain("playwright=present");
    expect(recommendation.onboardingChecklist.find((item) => item.id === "inspect-repository")?.evidence).toContain("routes=3");
    expect(recommendation.setupPullRequest.securityNotes.join(" ")).toContain("pull_request");
    expect(recommendation.setupActions.map((action) => action.id)).toContain("use-free-local-setup");
    expect(recommendation.setupActions.find((action) => action.id === "skip-provider-for-now")).toMatchObject({
      category: "provider",
      requiresConfirmation: false,
      writes: [".visual-hive/provider-decisions.json"]
    });
    expect(recommendation.setupActions.find((action) => action.id === "preview-setup-pr")?.safetyNotes.join(" ")).toContain("pull_request");
    expect(recommendation.detectedWorkflows).toEqual([
      {
        path: ".github/workflows/ci.yml",
        triggers: ["pull_request"],
        permissions: ["contents: read"],
        usesPullRequestTarget: false,
        usesSecrets: false,
        visualHiveRelated: false
      },
      {
        path: ".github/workflows/legacy.yml",
        triggers: ["pull_request_target"],
        permissions: ["contents: write"],
        usesPullRequestTarget: true,
        usesSecrets: true,
        visualHiveRelated: false
      }
    ]);
    expect(recommendation.findings.map((finding) => finding.message)).toContain(
      "Existing workflow uses pull_request_target. Do not execute untrusted PR code in that workflow."
    );
    expect(recommendation.warnings).toContain("One or more existing workflows use pull_request_target; keep Visual Hive PR checks on pull_request.");
    expect(recommendation.workflowPreviews.map((workflow) => workflow.id)).toEqual([
      "pull_request",
      "scheduled",
      "trusted_failure_issue",
      "trusted_hive_handoff"
    ]);
    expect(recommendation.workflowPreviews.find((workflow) => workflow.id === "pull_request")).toMatchObject({
      path: ".github/workflows/visual-hive-pr.yml",
      label: "Visual Hive PR"
    });
    expect(recommendation.workflowPreviews.find((workflow) => workflow.id === "pull_request")?.content).toContain("pull_request:");
    expect(recommendation.workflowPreviews.find((workflow) => workflow.id === "pull_request")?.content).toContain("include-hidden-files: true");
    expect(recommendation.workflowPreviews.find((workflow) => workflow.id === "trusted_failure_issue")?.content).toContain("workflow_run:");
    expect(recommendation.workflowPreviews.find((workflow) => workflow.id === "trusted_hive_handoff")?.content).toContain("hive-bead-request.json");
    expect(recommendation.workflowPreviews.find((workflow) => workflow.id === "trusted_hive_handoff")?.content).toContain("hive/guarded-repair-preview.json");
    expect(recommendation.workflowPreviews.find((workflow) => workflow.id === "trusted_hive_handoff")?.content).toContain("hive/repair-request-envelope.json");
    const setupPrPlan = buildSetupPullRequestPlan(recommendation, new Date("2026-06-15T00:00:00.000Z"));
    expect(setupPrPlan.outputResource).toEqual({
      artifactPath: ".visual-hive/setup-pr-plan.json",
      evidenceResourceId: "setup-pr-plan",
      evidenceResourceUri: "visual-hive://setup-pr-plan",
      evidenceResourceTitle: "Setup Pull Request Plan",
      evidenceResourceDescription: "No-network setup PR plan with proposed files, workflow safety checks, provider posture, and validation commands.",
      evidenceReadToolName: "visual_hive_read_setup_pr_plan"
    });
    expect(setupPrPlan).toMatchObject({
      schemaVersion: 1,
      project: "sample-dashboard",
      setupProfile: "free-local",
      status: "review",
      summary: {
        externalCallsMade: 0,
        workflowsPlanned: 4,
        requiresReview: true
      }
    });
    expect(setupPrPlan.files.map((file) => file.path)).toEqual([
      ".github/workflows/visual-hive-failure-issue.yml",
      ".github/workflows/visual-hive-hive-handoff.yml",
      ".github/workflows/visual-hive-pr.yml",
      ".github/workflows/visual-hive-scheduled.yml",
      ".visual-hive/recommendations.json",
      ".visual-hive/setup-bundle-edits.json",
      ".visual-hive/setup-pr-plan.json",
      "docs/visual-hive.md",
      "visual-hive.config.yaml"
    ]);
    expect(setupPrPlan.security).toMatchObject({
      generatedWorkflowsUsePullRequestTarget: false,
      generatedPrWorkflowUsesSecrets: false,
      issueCreationFromUntrustedPr: false,
      pullRequestSecretsRequired: []
    });
    expect(setupPrPlan.steps.find((step) => step.id === "write-setup-files")?.command).toBe("visual-hive recommend --write-setup-bundle");
    expect(setupPrPlan.providerDecisions.find((provider) => provider.providerId === "argos")).toMatchObject({
      requiredEnv: ["ARGOS_TOKEN"],
      externalUploadAllowedByDefault: false
    });
    expect(recommendation.onboardingChecklist.map((item) => item.id)).toEqual([
      "inspect-repository",
      "choose-pr-safe-target",
      "seed-starter-contracts",
      "verify-pr-safety",
      "generate-setup-files",
      "validate-locally"
    ]);
    expect(recommendation.onboardingChecklist.find((item) => item.id === "verify-pr-safety")).toMatchObject({
      status: "ready",
      relatedArtifacts: expect.arrayContaining([".github/workflows/visual-hive-pr.yml"])
    });
    expect(recommendation.onboardingChecklist.find((item) => item.id === "validate-locally")?.command).toContain("visual-hive doctor");
    expect(parsedYaml.contracts[0]?.id).toBe("app-shell-visual-stability");
    expect(parsedYaml.contracts[0]?.steps[0]?.action).toBe("assertVisible");
    expect(parsedYaml.contracts.map((contract) => contract.id)).toEqual([
      "app-shell-visual-stability",
      "route-clusters-visual-stability",
      "route-settings-visual-stability",
      "route-workloads-visual-stability"
    ]);
    expect(parsedYaml.contracts.find((contract) => contract.id === "route-settings-visual-stability")).toMatchObject({
      target: "localPreview",
      severity: "medium",
      selectors: { mustExist: ["[data-testid='dashboard-page']"] }
    });
    expect(parsedYaml.selection.changedFiles).toEqual([
      {
        pattern: "src/routes/**",
        contracts: ["route-clusters-visual-stability", "route-settings-visual-stability", "route-workloads-visual-stability"],
        risk: "medium"
      },
      {
        pattern: "src/pages/**",
        contracts: ["route-clusters-visual-stability", "route-settings-visual-stability", "route-workloads-visual-stability"],
        risk: "medium"
      },
      {
        pattern: "app/**",
        contracts: ["route-clusters-visual-stability", "route-settings-visual-stability", "route-workloads-visual-stability"],
        risk: "medium"
      },
      {
        pattern: "pages/**",
        contracts: ["route-clusters-visual-stability", "route-settings-visual-stability", "route-workloads-visual-stability"],
        risk: "medium"
      },
      {
        pattern: "src/**",
        contracts: [
          "app-shell-visual-stability",
          "route-clusters-visual-stability",
          "route-settings-visual-stability",
          "route-workloads-visual-stability"
        ],
        risk: "medium"
      }
    ]);
    expect(parsedYaml.project.setupProfile).toBe("free-local");
    expect(parsedYaml.targets.localPreview.kind).toBe("command");

    const setupDocs = buildSetupDocsMarkdown(recommendation);
    expect(setupDocs).toContain("# Visual Hive");
    expect(setupDocs).toContain("## PR Lane");
    expect(setupDocs).toContain("## Playwright Presence");
    expect(setupDocs).toContain("Status: present");
    expect(setupDocs).toContain("@playwright/test");
    expect(setupDocs).toContain("## Detected Route Hints");
    expect(setupDocs).toContain("/clusters");
    expect(setupDocs).toContain("PR checks should run with read-only permissions and no repository secrets.");
    expect(setupDocs).toContain("Serve command: npm run preview -- --port 4173 --strictPort");
    expect(setupDocs).toContain("app-shell-visual-stability");
    expect(setupDocs).toContain("route-clusters-visual-stability");
    expect(setupDocs).toContain("Playwright built-in");
    expect(setupDocs).toContain("## Onboarding Checklist");
    expect(setupDocs).toContain("### Verify PR safety");
    expect(setupDocs).toContain("## Setup Actions");
    expect(setupDocs).toContain("Use free local setup");
    expect(setupDocs).toContain("visual-hive providers decision --provider argos");
    expect(setupDocs).toContain("## Existing Workflow Hints");
    expect(setupDocs).toContain(".github/workflows/legacy.yml");
    expect(setupDocs).toContain("uses pull_request_target");
    expect(setupDocs).toContain("## Workflow Previews");
    expect(setupDocs).toContain("### Visual Hive PR");
    expect(setupDocs).toContain(".github/workflows/visual-hive-pr.yml");
    expect(setupDocs).toContain("include-hidden-files: true");
    expect(setupDocs).toContain("visual-hive workflows --write-templates");
    expect(setupDocs).toContain("Use `pull_request`, not `pull_request_target`");
  });

  it("recommends a component-storybook profile when Storybook is detected", async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-recommend-storybook-"));
    tempDirs.push(targetRoot);
    await writeJson(path.join(targetRoot, "package.json"), {
      name: "storybook-fixture",
      scripts: {
        build: "vite build",
        storybook: "storybook dev -p 6006",
        preview: "vite preview"
      },
      dependencies: {
        react: "^19.0.0",
        vite: "^6.0.0",
        "@storybook/react-vite": "^8.0.0"
      }
    });
    await mkdir(path.join(targetRoot, "src", "components"), { recursive: true });
    await writeFile(path.join(targetRoot, "src", "components", "Card.tsx"), `<section data-testid="dashboard-card">Card</section>`, "utf8");
    await writeFile(path.join(targetRoot, "src", "components", "Banner.tsx"), `<section data-testid="dashboard-card">Banner</section>`, "utf8");
    await writeFile(
      path.join(targetRoot, "src", "components", "Card.stories.tsx"),
      `
import { Card } from "./Card";
export default { title: "Dashboard/Card", component: Card };
export const Primary = {};
`,
      "utf8"
    );
    await writeFile(
      path.join(targetRoot, "src", "components", "Banner.stories.tsx"),
      `
export default { title: "Dashboard/Banner" };
export const Alert = {};
`,
      "utf8"
    );

    const recommendation = await recommendSetup({ repoRoot: targetRoot, now: new Date("2026-06-15T00:00:00.000Z") });
    const parsedYaml = VisualHiveConfigSchema.parse(parseYaml(recommendation.recommendedConfigYaml));

    expect(recommendation.setupProfile).toBe("component-storybook");
    expect(recommendation.project.detectedFrameworks).toContain("storybook");
    expect(recommendation.recommendedTarget).toMatchObject({
      id: "componentLibrary",
      kind: "storybook",
      url: "http://127.0.0.1:6006",
      serve: "npm run storybook -- --host 127.0.0.1 --port 6006"
    });
    expect(parsedYaml.targets.componentLibrary.kind).toBe("storybook");
    expect(parsedYaml.targets.componentLibrary).toMatchObject({
      stories: ["src/**/*.stories.@(js|jsx|ts|tsx|mdx)"],
      components: ["src/components/**"]
    });
    expect(recommendation.detectedStories).toEqual([
      {
        storyFile: "src/components/Banner.stories.tsx",
        title: "Dashboard/Banner",
        exports: ["Alert"],
        route: "/iframe.html?id=dashboard-banner--alert&viewMode=story"
      },
      {
        storyFile: "src/components/Card.stories.tsx",
        title: "Dashboard/Card",
        exports: ["Primary"],
        route: "/iframe.html?id=dashboard-card--primary&viewMode=story"
      }
    ]);
    expect(recommendation.recommendedContracts.map((contract) => contract.id)).toEqual([
      "storybook-dashboard-banner-alert-visual-stability",
      "storybook-dashboard-card-primary-visual-stability"
    ]);
    expect(recommendation.recommendedContracts[0]).toMatchObject({
      id: "storybook-dashboard-banner-alert-visual-stability",
      targetId: "componentLibrary",
      selectors: ["[data-testid='dashboard-card']"]
    });
    expect(parsedYaml.contracts.map((contract) => contract.id)).toEqual([
      "storybook-dashboard-banner-alert-visual-stability",
      "storybook-dashboard-card-primary-visual-stability"
    ]);
    expect(parsedYaml.contracts[0]).toMatchObject({
      id: "storybook-dashboard-banner-alert-visual-stability",
      target: "componentLibrary",
      selectors: { mustExist: ["[data-testid='dashboard-card']"] }
    });
    expect(parsedYaml.contracts[0]?.screenshots.map((screenshot) => screenshot.route)).toEqual([
      "/iframe.html?id=dashboard-banner--alert&viewMode=story",
      "/iframe.html?id=dashboard-banner--alert&viewMode=story"
    ]);
    expect(parsedYaml.contracts[1]?.screenshots.map((screenshot) => screenshot.route)).toEqual([
      "/iframe.html?id=dashboard-card--primary&viewMode=story",
      "/iframe.html?id=dashboard-card--primary&viewMode=story"
    ]);
    const storybookContractIds = [
      "storybook-dashboard-banner-alert-visual-stability",
      "storybook-dashboard-card-primary-visual-stability"
    ];
    expect(parsedYaml.selection.changedFiles).toEqual([
      {
        pattern: "src/**/*.stories.*",
        contracts: storybookContractIds,
        risk: "medium"
      },
      {
        pattern: "src/components/**",
        contracts: storybookContractIds,
        risk: "medium"
      },
      {
        pattern: "src/**",
        contracts: storybookContractIds,
        risk: "low"
      }
    ]);
    expect(recommendation.providerRecommendations.find((provider) => provider.providerId === "chromatic")).toMatchObject({
      recommendation: "optional",
      requiredEnv: ["CHROMATIC_PROJECT_TOKEN"],
      externalUploadAllowedByDefault: false
    });
    expect(recommendation.setupActions.find((action) => action.id === "skip-provider-for-now")?.command).toContain("--provider chromatic");
    expect(recommendation.costEstimate.localScreenshotsPerRun).toBe(4);
    expect(recommendation.costEstimate.externalScreenshotsPerRun).toBe(4);
    expect(parsedYaml.costPolicy.maxExternalScreenshotsPerRun).toBeGreaterThanOrEqual(4);
    expect(parsedYaml.costPolicy.externalUpload.pullRequest).toBe(false);
    const setupDocs = buildSetupDocsMarkdown(recommendation);
    expect(setupDocs).toContain("## Detected Storybook Stories");
    expect(setupDocs).toContain("src/components/Banner.stories.tsx");
    expect(setupDocs).toContain("src/components/Card.stories.tsx");
    expect(setupDocs).toContain("/iframe.html?id=dashboard-banner--alert&viewMode=story");
    expect(setupDocs).toContain("/iframe.html?id=dashboard-card--primary&viewMode=story");
  });

  it("recommends a commandGroup target for complex fullstack and fake OAuth scripts", async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-recommend-fullstack-"));
    tempDirs.push(targetRoot);
    await writeJson(path.join(targetRoot, "package.json"), {
      name: "fullstack-fixture",
      scripts: {
        "build:web": "vite build",
        "build:api": "tsc -p server",
        "dev:web": "vite --host 127.0.0.1 --port 5173",
        "dev:api": "node server.js --port 8081",
        "fake-oauth": "node fake-oauth.js --port 8788"
      },
      dependencies: {
        react: "^19.0.0",
        vite: "^6.0.0"
      }
    });
    await mkdir(path.join(targetRoot, "src"), { recursive: true });
    await writeFile(
      path.join(targetRoot, "src", "App.tsx"),
      `<main data-testid="dashboard-page"><a href="/settings">Settings</a></main>`,
      "utf8"
    );

    const recommendation = await recommendSetup({ repoRoot: targetRoot, now: new Date("2026-06-15T00:00:00.000Z") });
    const parsedYaml = VisualHiveConfigSchema.parse(parseYaml(recommendation.recommendedConfigYaml));

    expect(recommendation.setupProfile).toBe("complex-app");
    expect(recommendation.recommendedTarget).toMatchObject({
      id: "fakeOAuthFullstack",
      kind: "commandGroup",
      url: "http://127.0.0.1:5173",
      setup: ["npm run build:api", "npm run build:web"],
      services: [
        {
          name: "backend",
          command: "npm run dev:api",
          url: "http://127.0.0.1:8081/health",
          readinessTimeoutMs: 30000
        },
        {
          name: "fakeOAuth",
          command: "npm run fake-oauth",
          url: "http://127.0.0.1:8788/health",
          readinessTimeoutMs: 30000
        },
        {
          name: "frontend",
          command: "npm run dev:web",
          url: "http://127.0.0.1:5173",
          readinessTimeoutMs: 30000
        }
      ]
    });
    expect(parsedYaml.targets.fakeOAuthFullstack).toMatchObject({
      kind: "commandGroup",
      url: "http://127.0.0.1:5173",
      prSafe: true,
      cost: "medium"
    });
    expect(parsedYaml.targets.fakeOAuthFullstack.services.map((service) => service.name)).toEqual(["backend", "fakeOAuth", "frontend"]);
    expect(parsedYaml.contracts.map((contract) => contract.id)).toEqual(["app-shell-visual-stability", "route-settings-visual-stability"]);
    expect(recommendation.costEstimate.ciRuntimeClass).toBe("expensive");
    expect(recommendation.permissions.scheduled.secretsRequired).toEqual(["PROTECTED_TARGET_SECRET_NAMES"]);

    const setupDocs = buildSetupDocsMarkdown(recommendation);
    expect(setupDocs).toContain("Services:");
    expect(setupDocs).toContain("fakeOAuth: npm run fake-oauth");
    expect(setupDocs).toContain("Setup commands: npm run build:api, npm run build:web");
  });

  it("honors an explicit hosted-review setup profile without enabling PR uploads", async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-recommend-hosted-profile-"));
    tempDirs.push(targetRoot);
    await writeJson(path.join(targetRoot, "package.json"), {
      name: "hosted-profile-fixture",
      scripts: {
        build: "vite build",
        preview: "vite preview"
      },
      dependencies: {
        react: "^19.0.0",
        vite: "^6.0.0"
      }
    });
    await mkdir(path.join(targetRoot, "src"), { recursive: true });
    await writeFile(path.join(targetRoot, "src", "App.tsx"), `<main data-testid="dashboard-page">Dashboard</main>`, "utf8");

    const recommendation = await recommendSetup({
      repoRoot: targetRoot,
      setupProfile: "hosted-review",
      now: new Date("2026-06-15T00:00:00.000Z")
    });
    const parsedYaml = VisualHiveConfigSchema.parse(parseYaml(recommendation.recommendedConfigYaml));

    expect(recommendation.setupProfile).toBe("hosted-review");
    expect(recommendation.costEstimate).toMatchObject({
      localScreenshotsPerRun: 2,
      externalScreenshotsPerRun: 2,
      estimatedMonthlyExternalScreenshots: 40
    });
    expect(recommendation.providerRecommendations.find((provider) => provider.providerId === "argos")).toMatchObject({
      recommendation: "optional",
      requiredEnv: ["ARGOS_TOKEN"],
      externalUploadAllowedByDefault: false
    });
    expect(recommendation.providerRecommendations.find((provider) => provider.providerId === "percy")?.recommendation).toBe("optional");
    expect(parsedYaml.project.setupProfile).toBe("hosted-review");
    expect(parsedYaml.costPolicy.maxExternalScreenshotsPerRun).toBeGreaterThanOrEqual(2);
    expect(parsedYaml.costPolicy.externalUpload.pullRequest).toBe(false);
    expect(parsedYaml.costPolicy.externalUpload.onFailureOnly).toBe(true);
  });

  it("handles package.json files with a UTF-8 BOM during setup scanning", async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-recommend-bom-"));
    tempDirs.push(targetRoot);
    await writeFile(
      path.join(targetRoot, "package.json"),
      `\uFEFF${JSON.stringify({
        name: "bom-fixture",
        scripts: { build: "vite build", preview: "vite preview" },
        dependencies: { react: "^19.0.0", vite: "^6.0.0" }
      })}`,
      "utf8"
    );
    await mkdir(path.join(targetRoot, "src"), { recursive: true });
    await writeFile(path.join(targetRoot, "src", "App.tsx"), `<main data-testid="dashboard-page">Dashboard</main>`, "utf8");

    const recommendation = await recommendSetup({ repoRoot: targetRoot, now: new Date("2026-06-15T00:00:00.000Z") });

    expect(recommendation.project.name).toBe("bom-fixture");
    expect(recommendation.project.type).toBe("react-vite");
    expect(recommendation.recommendedTarget.serve).toBe("npm run preview -- --port 4173 --strictPort");
  });
});

describe("local repository connections", () => {
  it("adds, lists, inspects, and removes connected repositories", async () => {
    const managerRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-connections-manager-"));
    const connectedRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-connections-target-"));
    tempDirs.push(managerRoot, connectedRoot);
    await writeMinimalConfig(managerRoot, "manager-project");
    await writeMinimalConfig(connectedRoot, "connected-project");
    await writeJson(path.join(connectedRoot, ".visual-hive", "report.json"), {
      schemaVersion: 2,
      project: "connected-project",
      repository: sampleRepository,
      mode: "pr",
      generatedAt: "2026-06-15T00:00:00.000Z",
      status: "passed",
      changedFiles: [],
      selectedTargets: [],
      selectedContracts: [],
      excludedContracts: [],
      targetLifecycle: [],
      generatedSpecPath: ".visual-hive/generated/visual-hive.generated.spec.ts",
      results: [],
      summary: {
        passed: 0,
        failed: 0,
        screenshotsPassed: 0,
        screenshotsFailed: 0,
        baselinesCreated: 0,
        createdBaselines: 0,
        missingBaselines: 0,
        visualDiffs: 0,
        consoleErrors: 0,
        pageErrors: 0
      },
      consoleErrors: [],
      pageErrors: [],
      artifacts: [],
      reproductionCommands: []
    });

    const added = await addConnection({
      repoRoot: managerRoot,
      repoPath: connectedRoot,
      id: "console",
      label: "Console",
      tags: ["dogfood"]
    });

    expect(added.summary.storedConnections).toBe(1);
    expect(added.connections.find((connection) => connection.id === "console")).toMatchObject({
      status: "ready",
      projectName: "connected-project",
      latestDeterministicStatus: "passed",
      tags: ["dogfood"]
    });

    const listed = await listConnections({ repoRoot: managerRoot });
    expect(listed.connections.map((connection) => connection.id)).toContain("current");
    expect(listed.connections.map((connection) => connection.id)).toContain("console");

    const removed = await removeConnection({ repoRoot: managerRoot, id: "console" });
    expect(removed.connections.map((connection) => connection.id)).not.toContain("console");
  });

  it("refuses connection stores outside the managing repo", async () => {
    const managerRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-connections-safe-"));
    tempDirs.push(managerRoot);
    await writeMinimalConfig(managerRoot, "manager-project");

    await expect(listConnections({ repoRoot: managerRoot, connectionsPath: path.join(managerRoot, "..", "connections.json") })).rejects.toThrow(
      /outside the repository root/
    );
  });

  it("summarizes connected repository health from reports, mutation score, and risk", async () => {
    const managerRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-connections-health-manager-"));
    const connectedRoot = await mkdtemp(path.join(os.tmpdir(), "visual-hive-connections-health-target-"));
    const now = new Date("2026-06-16T00:00:00.000Z");
    tempDirs.push(managerRoot, connectedRoot);
    await writeMinimalConfig(managerRoot, "manager-project");
    await writeMinimalConfig(connectedRoot, "connected-project");
    await writeJson(path.join(managerRoot, ".visual-hive", "report.json"), connectionReport("manager-project", "passed"));
    await writeJson(path.join(managerRoot, ".visual-hive", "coverage.json"), connectionCoverage("manager-project", []));
    await writeJson(path.join(connectedRoot, ".visual-hive", "report.json"), connectionReport("connected-project", "failed", "2026-06-01T00:00:00.000Z"));
    await writeJson(path.join(connectedRoot, ".visual-hive", "mutation-report.json"), {
      schemaVersion: 2,
      project: "connected-project",
      generatedAt: "2026-06-15T00:10:00.000Z",
      minScore: 0.75,
      score: 0.5,
      killed: 1,
      total: 2,
      results: []
    });
    await writeJson(
      path.join(connectedRoot, ".visual-hive", "coverage.json"),
      connectionCoverage("connected-project", [
        { kind: "target_without_contracts", severity: "high", message: "Admin target has no contracts.", targetId: "admin" },
        { kind: "contract_without_assertions", severity: "low", message: "Settings contract has no assertions.", contractId: "settings" },
        { kind: "viewport_without_screenshots", severity: "medium", message: "Mobile viewport has no screenshots.", viewport: "mobile" }
      ])
    );
    await writeJson(path.join(connectedRoot, ".visual-hive", "risk.json"), {
      schemaVersion: 1,
      project: "connected-project",
      generatedAt: "2026-06-15T00:20:00.000Z",
      summary: {
        total: 2,
        critical: 0,
        high: 1,
        medium: 1,
        low: 0,
        riskScore: 62,
        highestSeverity: "high",
        prBlocking: 1,
        trustedOnly: 0
      },
      inputs: {
        plan: true,
        report: true,
        mutationReport: true,
        coverageReport: false,
        targetAudit: false,
        contractAudit: false,
        flowAudit: false,
        scheduleAudit: false,
        workflowAudit: false
      },
      risks: [],
      recommendations: []
    });
    await writeJson(path.join(connectedRoot, ".visual-hive", "readiness.json"), {
      schemaVersion: 1,
      project: "connected-project",
      generatedAt: "2026-06-15T00:25:00.000Z",
      status: "blocked",
      score: 58,
      summary: { total: 4, passed: 1, warnings: 1, blocked: 2, missing: 0 },
      inputs: {
        plan: true,
        report: true,
        mutationReport: true,
        baselines: true,
        workflowAudit: true,
        securityAudit: true,
        costAudit: true
      },
      gates: [],
      nextActions: []
    });
    await writeJson(path.join(connectedRoot, ".visual-hive", "security.json"), {
      schemaVersion: 1,
      project: "connected-project",
      generatedAt: "2026-06-15T00:30:00.000Z",
      summary: {
        score: 72,
        totalFindings: 2,
        critical: 1,
        high: 1,
        medium: 0,
        low: 0,
        prBlocking: 1,
        trustedOnly: 1,
        npmAuditSource: "not_run",
        npmAuditTotal: 0
      },
      inputs: { workflowAudit: true, npmAudit: false },
      npmAudit: { source: "not_run", total: 0, critical: 0, high: 0, moderate: 0, low: 0, info: 0 },
      findings: [],
      recommendations: []
    });
    await writeJson(path.join(connectedRoot, ".visual-hive", "costs.json"), {
      schemaVersion: 1,
      project: "connected-project",
      generatedAt: "2026-06-15T00:35:00.000Z",
      mode: "pr",
      summary: {
        selectedContracts: 2,
        selectedTargets: 1,
        localScreenshots: 3,
        estimatedExternalScreenshots: 3,
        externalCallsPlanned: 0,
        externalCallsMade: 0,
        enabledExternalProviders: 1,
        policyBlockedProviders: 1,
        missingCredentialProviders: 0,
        expensiveTargetsSelected: 0,
        mutationOperators: 0,
        maxExternalScreenshotsPerRun: 0,
        maxMonthlyExternalScreenshots: 100,
        budgetStatus: "blocked"
      },
      costPolicy: sampleConfig().costPolicy,
      targets: [],
      providers: [],
      risks: [],
      recommendations: []
    });

    await addConnection({
      repoRoot: managerRoot,
      repoPath: connectedRoot,
      id: "risky-console",
      label: "Risky Console",
      now
    });

    const index = await listConnections({ repoRoot: managerRoot, now });
    const connection = index.connections.find((candidate) => candidate.id === "risky-console");

    expect(index.summary.failedConnections).toBe(1);
    expect(index.summary.staleReportConnections).toBe(1);
    expect(index.summary.weakMutationConnections).toBe(1);
    expect(index.summary.coverageGapConnections).toBe(1);
    expect(index.summary.highCoverageGapConnections).toBe(1);
    expect(index.summary.highRiskConnections).toBe(1);
    expect(index.summary.readinessBlockedConnections).toBe(1);
    expect(index.summary.securityRiskConnections).toBe(1);
    expect(index.summary.costPolicyConnections).toBe(1);
    expect(index.summary.connectionsNeedingAttention).toBe(1);
    expect(index.portfolio.queues.find((queue) => queue.id === "deterministic_failures")?.connections.map((item) => item.id)).toContain("risky-console");
    expect(index.portfolio.queues.find((queue) => queue.id === "stale_reports")?.connections.map((item) => item.id)).toContain("risky-console");
    expect(index.portfolio.queues.find((queue) => queue.id === "coverage_gaps")?.connections.map((item) => item.id)).toContain("risky-console");
    expect(index.portfolio.queues.find((queue) => queue.id === "weak_mutation")?.connections.map((item) => item.id)).toContain("risky-console");
    expect(index.portfolio.queues.find((queue) => queue.id === "high_risk")?.connections.map((item) => item.id)).toContain("risky-console");
    expect(index.portfolio.queues.find((queue) => queue.id === "readiness_blocked")?.connections.map((item) => item.id)).toContain("risky-console");
    expect(index.portfolio.queues.find((queue) => queue.id === "security_risks")?.connections.map((item) => item.id)).toContain("risky-console");
    expect(index.portfolio.queues.find((queue) => queue.id === "cost_policy")?.connections.map((item) => item.id)).toContain("risky-console");
    expect(index.portfolio.topAttention[0]).toMatchObject({ id: "risky-console", health: "attention" });
    expect(connection).toMatchObject({
      health: "attention",
      latestDeterministicStatus: "failed",
      latestReportAgeDays: 15,
      staleReport: true,
      latestMutationScore: 0.5,
      mutationMinScore: 0.75,
      mutationKilled: 1,
      mutationTotal: 2,
      coverageGapCount: 3,
      highCoverageGapCount: 1,
      mediumCoverageGapCount: 1,
      uncoveredTargets: 1,
      uncoveredContracts: 1,
      latestRiskScore: 62,
      latestRiskSeverity: "high",
      latestReadinessStatus: "blocked",
      latestReadinessScore: 58,
      readinessBlocked: 2,
      readinessWarnings: 1,
      latestSecurityScore: 72,
      securityCriticalHigh: 2,
      latestCostBudgetStatus: "blocked",
      costPolicyBlockedProviders: 1
    });
    expect(connection?.attention.join(" ")).toContain("Latest deterministic run failed");
    expect(connection?.attention.join(" ")).toContain("Latest deterministic report is stale");
    expect(connection?.attention.join(" ")).toContain("Mutation score 50% is below minimum 75%");
    expect(connection?.attention.join(" ")).toContain("Coverage has 1 high-severity gap");
    expect(connection?.attention.join(" ")).toContain("Risk register needs review");
    expect(connection?.attention.join(" ")).toContain("Readiness gate is blocked");
    expect(connection?.attention.join(" ")).toContain("Security audit has 2 critical/high findings");
    expect(connection?.attention.join(" ")).toContain("Cost policy is blocked");
  });
});

describe("evidence packets", () => {
  it("aggregates deterministic and mutation evidence into a Visual Hive verdict", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-evidence-"));
    tempDirs.push(rootDir);
    const actualPath = ".visual-hive/artifacts/screenshots/dashboard.png";
    const baselinePath = ".visual-hive/snapshots/dashboard.png";
    const report = reportFixture(rootDir, actualPath, baselinePath);
    report.results[0]?.errors.push("token=super-secret-value");
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);
    const mutationReport: MutationReport = {
      schemaVersion: 2,
      project: "baseline-fixture",
      generatedAt: "2026-06-15T00:01:00.000Z",
      minScore: 0.75,
      score: 1 / 3,
      killed: 1,
      total: 3,
      results: [
        {
          operator: "hide-critical-button",
          status: "killed",
          killed: true,
          contractIds: ["dashboard"],
          applicable: true,
          expectedFailureKinds: ["missing_element"],
          durationMs: 8,
          errors: ["Critical button hidden"],
          artifacts: [".visual-hive/mutation-report.json"],
          affected: [{ contractId: "dashboard", targetId: "local", route: "/", component: "critical-action", viewport: "desktop" }],
          suggestedMissingTest: "Keep mutation hide-critical-button mapped to dashboard.",
          validationCommand: "visual-hive mutate --config visual-hive.config.yaml --enforce-min-score",
          mutationMode: "runtime",
          sourceMutation: false
        },
        {
          operator: "force-login-on-demo",
          status: "survived",
          killed: false,
          contractIds: ["dashboard"],
          applicable: true,
          expectedFailureKinds: ["unexpected_element"],
          failedAssertion: "Login exposure mutation survived with token=secret-value",
          durationMs: 10,
          errors: [],
          artifacts: [".visual-hive/mutation-report.json"]
        },
        {
          operator: "mobile-overflow",
          status: "not_applicable",
          killed: false,
          contractIds: [],
          applicable: false,
          durationMs: 1,
          errors: []
        }
      ]
    };
    await writeJson(path.join(rootDir, ".visual-hive", "mutation-report.json"), mutationReport);

    const result = await writeEvidencePacket({
      rootDir,
      project: "baseline-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });

    expect(result.packet.verdictSummary.visualHiveVerdict).toBe("failed");
    expect(result.packet.verdictSummary.failedBecause).toEqual(
      expect.arrayContaining(["playwright.deterministic_run", "mutation.mutation_adequacy", "mutation.mutation_survivor.force-login-on-demo"])
    );
    expect(JSON.stringify(result.packet)).not.toContain("super-secret-value");
    expect(JSON.stringify(result.packet)).toContain("[REDACTED]");
    expect(result.packet.governance.verdictAuthority).toBe("visual_hive");
    expect(result.packet.governance.defaultBrowserBackend).toBe("playwright");
    expect(result.packet.evidenceContributions.every((contribution) => contribution.key.length > 0)).toBe(true);
    expect(result.packet.evidenceContributions.find((contribution) => contribution.key === "mutation.mutation_survivor.force-login-on-demo")?.authority).toBe("gating");
    expect(result.packet.evidenceContributions.find((contribution) => contribution.key === "mutation.not_applicable.mobile-overflow")?.authority).toBe("advisory");
    expect(result.packet.mutation?.killedOperators[0]).toMatchObject({
      operator: "hide-critical-button",
      contractIds: ["dashboard"],
      affected: [{ contractId: "dashboard", targetId: "local", route: "/", component: "critical-action", viewport: "desktop" }]
    });
    expect(result.packet.mutation?.survivedOperators[0]?.operator).toBe("force-login-on-demo");
    expect(result.packet.testingLayers.find((layer) => layer.id === 9)?.status).toBe("covered");
    expect(await readFile(result.packetPath, "utf8")).toContain("visual-hive.evidence-packet.v2");
    expect(await readFile(result.summaryPath, "utf8")).toContain("Visual Hive verdict: failed");
  });

  it("marks missing deterministic evidence as inconclusive", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-evidence-empty-"));
    tempDirs.push(rootDir);
    const packet = await buildEvidencePacket({
      rootDir,
      project: "empty",
      now: new Date("2026-06-15T00:02:00.000Z")
    });
    expect(packet.verdictSummary.visualHiveVerdict).toBe("inconclusive");
    expect(packet.verdictSummary.blockedBecause).toContain("playwright.deterministic_run");
    expect(packet.hiveReadiness.readyForHiveDryRun).toBe(false);
  });

  it("treats CI missing baselines as blocked evidence instead of product failures", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-missing-baseline-verdict-"));
    tempDirs.push(rootDir);
    const report = reportFixture(
      rootDir,
      path.join(rootDir, ".visual-hive", "artifacts", "screenshots", "dashboard.png"),
      path.join(rootDir, ".visual-hive", "snapshots", "dashboard.png")
    );
    report.status = "failed";
    report.summary.screenshotsPassed = 0;
    report.summary.screenshotsFailed = 1;
    report.summary.missingBaselines = 1;
    report.results[0]!.status = "failed";
    report.results[0]!.errors = ["Missing screenshot baseline in CI mode."];
    report.results[0]!.screenshotAssertions![0]!.status = "missing_baseline";
    report.results[0]!.screenshotAssertions![0]!.message = "Missing screenshot baseline in CI mode.";

    const reportVerdict = buildReportVerdict(report);
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), {
      ...report,
      ...reportVerdict
    });
    const packet = await buildEvidencePacket({
      rootDir,
      project: "baseline-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });

    expect(reportVerdict.verdictSummary.visualHiveVerdict).toBe("blocked");
    expect(reportVerdict.verdictSummary.blockedBecause).toEqual(
      expect.arrayContaining(["playwright.deterministic_run", "playwright.contract_result.dashboard", "screenshot_diff.missing_baseline.dashboard"])
    );
    expect(reportVerdict.verdictSummary.failedBecause).toEqual([]);
    expect(packet.verdictSummary.visualHiveVerdict).toBe("blocked");
    expect(packet.verdictSummary.failedBecause).toEqual([]);
  });

  it("keeps supplemental provider failures advisory while oracle provider failures gate the verdict", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-provider-verdict-"));
    tempDirs.push(rootDir);
    const report = passedReportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png");
    report.providerResults = [
      {
        providerId: "argos",
        label: "Argos",
        status: "failed",
        deterministicRole: "supplemental",
        message: "Argos found a visual change, but PR provider gating is disabled.",
        requiredEnv: [],
        missingEnv: [],
        artifactCount: 1,
        normalizedAt: "2026-06-15T00:01:00.000Z"
      }
    ];
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);

    const advisoryPacket = await buildEvidencePacket({
      rootDir,
      project: "baseline-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });

    expect(advisoryPacket.verdictSummary.visualHiveVerdict).toBe("passed");
    expect(advisoryPacket.verdictSummary.failedBecause).toEqual([]);
    expect(advisoryPacket.verdictSummary.advisoryOnly).toContain("provider.normalized_provider_result.argos");
    expect(advisoryPacket.evidenceContributions.find((contribution) => contribution.key === "provider.normalized_provider_result.argos")).toMatchObject({
      source: "provider",
      status: "failed",
      gating: false,
      authority: "advisory"
    });

    report.providerResults[0]!.deterministicRole = "oracle";
    report.providerResults[0]!.message = "Argos failed after provider gating was explicitly enabled.";
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);

    const oraclePacket = await buildEvidencePacket({
      rootDir,
      project: "baseline-fixture",
      now: new Date("2026-06-15T00:03:00.000Z")
    });

    expect(oraclePacket.verdictSummary.visualHiveVerdict).toBe("failed");
    expect(oraclePacket.verdictSummary.failedBecause).toContain("provider.normalized_provider_result.argos");
    expect(oraclePacket.evidenceContributions.find((contribution) => contribution.key === "provider.normalized_provider_result.argos")).toMatchObject({
      status: "failed",
      gating: true,
      authority: "gating"
    });
  });

  it("normalizes provider upload evidence into the Evidence Packet without making supplemental providers authoritative", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-provider-upload-evidence-"));
    tempDirs.push(rootDir);
    const report = passedReportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png");
    report.providerResults = [
      {
        providerId: "argos",
        label: "Argos",
        status: "failed",
        deterministicRole: "supplemental",
        message: "Argos upload failed; deterministic Playwright status is unchanged.",
        requiredEnv: ["ARGOS_TOKEN"],
        missingEnv: [],
        artifactCount: 2,
        externalUploadAllowed: true,
        estimatedExternalScreenshots: 2,
        upload: {
          status: "failed",
          externalCallsMade: 1,
          uploadedArtifacts: 0,
          stagedArtifacts: 2,
          manifestPath: ".visual-hive/provider-upload/argos/manifest.json",
          uploadDirectory: ".visual-hive/provider-upload/argos",
          command: "npm exec argos upload --token=secret-token-value",
          stdout: "Uploaded URL https://app.argos-ci.com/build?token=secret-token-value",
          stderr: "Authorization: Bearer secret-token-value timed out",
          providerUrl: "https://app.argos-ci.com/build?access_token=secret-token-value",
          blockedReasons: ["provider timeout after token=secret-token-value"]
        },
        normalizedAt: "2026-06-15T00:01:00.000Z"
      }
    ];
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);

    const packet = await buildEvidencePacket({
      rootDir,
      project: "baseline-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });

    const argos = packet.providers.find((provider) => provider.providerId === "argos");
    expect(packet.verdictSummary.visualHiveVerdict).toBe("passed");
    expect(packet.verdictSummary.advisoryOnly).toEqual(
      expect.arrayContaining(["provider.normalized_provider_result.argos", "provider.provider_upload.argos"])
    );
    expect(packet.evidenceContributions.find((contribution) => contribution.key === "provider.provider_upload.argos")).toMatchObject({
      status: "blocked",
      gating: false,
      authority: "advisory"
    });
    expect(argos?.upload).toMatchObject({
      status: "failed",
      externalCallsMade: 1,
      stagedArtifacts: 2,
      manifestPath: ".visual-hive/provider-upload/argos/manifest.json"
    });
    const serialized = JSON.stringify(packet);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("secret-token-value");
  });

  it("lets mutation adequacy fail the Visual Hive verdict even when deterministic contracts pass", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-mutation-verdict-"));
    tempDirs.push(rootDir);
    const report = passedReportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png");
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);
    const mutationReport: MutationReport = {
      schemaVersion: 2,
      project: "baseline-fixture",
      generatedAt: "2026-06-15T00:01:00.000Z",
      minScore: 0.75,
      score: 0.5,
      killed: 1,
      total: 2,
      results: [
        {
          operator: "force-login-on-demo",
          status: "survived",
          killed: false,
          contractIds: ["dashboard"],
          applicable: true,
          expectedFailureKinds: ["unexpected_element"],
          failedAssertion: "Mutation survived selected contracts.",
          durationMs: 10,
          errors: [],
          artifacts: [".visual-hive/mutation-report.json"]
        },
        {
          operator: "remove-demo-badge",
          status: "killed",
          killed: true,
          contractIds: ["dashboard"],
          applicable: true,
          expectedFailureKinds: ["missing_element"],
          durationMs: 8,
          errors: [],
          artifacts: [".visual-hive/mutation-report.json"]
        }
      ]
    };
    await writeJson(path.join(rootDir, ".visual-hive", "mutation-report.json"), mutationReport);

    const packet = await buildEvidencePacket({
      rootDir,
      project: "baseline-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });

    expect(packet.deterministicReport?.status).toBe("passed");
    expect(packet.verdictSummary.visualHiveVerdict).toBe("failed");
    expect(packet.verdictSummary.failedBecause).toEqual(
      expect.arrayContaining(["mutation.mutation_adequacy", "mutation.mutation_survivor.force-login-on-demo"])
    );
    expect(packet.evidenceContributions.find((contribution) => contribution.key === "playwright.deterministic_run")?.status).toBe("passed");
  });

  it("reports non-gating readiness warnings without turning them into deterministic failures", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-warning-verdict-"));
    tempDirs.push(rootDir);
    const report = passedReportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png");
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);
    await writeJson(path.join(rootDir, ".visual-hive", "readiness.json"), {
      status: "warning",
      score: 82,
      gates: [{ status: "warning", title: "Provider policy review", message: "Provider upload remains disabled." }]
    });

    const packet = await buildEvidencePacket({
      rootDir,
      project: "baseline-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });

    expect(packet.verdictSummary.visualHiveVerdict).toBe("warning");
    expect(packet.verdictSummary.failedBecause).toEqual([]);
    expect(packet.verdictSummary.warningBecause).toContain("readiness.readiness_gate");
    expect(packet.verdictSummary.advisoryOnly).toContain("readiness.readiness_gate");
    expect(packet.evidenceContributions.find((contribution) => contribution.key === "playwright.deterministic_run")?.status).toBe("passed");
  });

  it("feeds analyzed repo intelligence into Evidence Packet, testing layers, and Hive handoff work items", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-repo-evidence-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify(
        {
          name: "repo-evidence-fixture",
          scripts: {
            build: "vite build",
            preview: "vite preview --host 127.0.0.1 --port 4173"
          },
          dependencies: { react: "^19.0.0", vite: "^6.0.0" },
          devDependencies: { "@playwright/test": "^1.0.0" }
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(rootDir, "src", "App.tsx"),
      `<a href="/clusters" data-testid="dashboard-page">Clusters</a><button data-testid="critical-action-button">Run</button>`,
      "utf8"
    );
    const repoMap = await writeRepoMap({
      repoRoot: rootDir,
      now: new Date("2026-06-15T00:00:00.000Z")
    });
    const report = passedReportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png");
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);

    const evidence = await writeEvidencePacket({
      rootDir,
      project: "repo-evidence-fixture",
      now: new Date("2026-06-15T00:01:00.000Z")
    });
    const layers = await buildTestingLayerReport({
      rootDir,
      project: "repo-evidence-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });
    const handoff = buildHandoffArtifacts({
      evidencePacket: evidence.packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      now: new Date("2026-06-15T00:03:00.000Z")
    });

    expect(repoMap.reportPath).toBe(path.join(rootDir, ".visual-hive", "repo-map.json"));
    expect(evidence.packet.sourceArtifacts.repoMap).toBe(".visual-hive/repo-map.json");
    expect(evidence.packet.repoIntelligence).toMatchObject({
      project: expect.objectContaining({ name: "repo-evidence-fixture", frameworks: expect.arrayContaining(["react", "vite"]) }),
      selectorCount: 2,
      routeCount: 1
    });
    expect(evidence.packet.repoIntelligence?.coverageGaps.map((gap) => gap.id)).toEqual(
      expect.arrayContaining(["repo-intelligence-config", "workflow-safety", "unit-layer"])
    );
    expect(evidence.packet.testingLayers.find((layer) => layer.id === 0)).toMatchObject({
      name: "Repo intelligence",
      status: "covered",
      evidence: [".visual-hive/repo-map.json", ".visual-hive/repo-context.md"]
    });
    expect(layers.sourceArtifacts.repoMap).toBe(".visual-hive/repo-map.json");
    expect(layers.outputResource).toMatchObject({
      artifactPath: ".visual-hive/testing-layers.json",
      evidenceResourceId: "testing-layers",
      evidenceResourceUri: "visual-hive://testing-layers",
      evidenceReadToolName: "visual_hive_read_testing_layers"
    });
    expect(layers.layers.find((layer) => layer.id === 0)?.status).toBe("covered");
    expect(handoff.handoff.workItems.map((item) => item.evidenceKeys).flat()).toEqual(
      expect.arrayContaining(["repo_coverage_gap.repo-intelligence-config", "repo_coverage_gap.workflow-safety"])
    );
    expect(handoff.handoff.workItems.find((item) => item.evidenceKeys.includes("repo_coverage_gap.workflow-safety"))).toMatchObject({
      kind: "setup",
      priority: "medium",
      artifacts: expect.arrayContaining([".visual-hive/repo-map.json", ".visual-hive/repo-context.md"])
    });
    expect(handoff.issueBody).toContain("repo_coverage_gap.workflow-safety");
    expect(JSON.stringify(evidence.packet)).not.toContain("SECRET");
  });
});

describe("verdict reports", () => {
  it("writes a compact Visual Hive verdict from an Evidence Packet", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-verdict-"));
    tempDirs.push(rootDir);
    const report = reportFixture(
      rootDir,
      path.join(rootDir, ".visual-hive", "artifacts", "screenshots", "dashboard.png"),
      path.join(rootDir, ".visual-hive", "snapshots", "dashboard.png")
    );
    report.results[0]?.errors.push("Authorization: Bearer secret-value");
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);
    const mutationReport: MutationReport = {
      schemaVersion: 2,
      project: "baseline-fixture",
      generatedAt: "2026-06-15T00:01:00.000Z",
      minScore: 0.75,
      score: 0.5,
      killed: 1,
      total: 2,
      results: [
        {
          operator: "force-login-on-demo",
          status: "survived",
          killed: false,
          contractIds: ["dashboard"],
          applicable: true,
          expectedFailureKinds: ["unexpected_element"],
          failedAssertion: "Login exposure mutation survived with token=secret-value",
          durationMs: 10,
          errors: [],
          artifacts: [".visual-hive/mutation-report.json"]
        }
      ]
    };
    await writeJson(path.join(rootDir, ".visual-hive", "mutation-report.json"), mutationReport);
    await writeEvidencePacket({
      rootDir,
      project: "baseline-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });

    const result = await writeVerdictReport({
      rootDir,
      project: "baseline-fixture",
      now: new Date("2026-06-15T00:03:00.000Z")
    });

    expect(result.report.schemaVersion).toBe("visual-hive.verdict.v1");
    expect(result.report.summary.visualHiveVerdict).toBe("failed");
    expect(result.report.summary.failedBecause).toEqual(
      expect.arrayContaining(["playwright.deterministic_run", "mutation.mutation_adequacy", "mutation.mutation_survivor.force-login-on-demo"])
    );
    expect(result.report.governance.verdictAuthority).toBe("visual_hive");
    expect(result.report.policy.passFailOwnedBy).toBe("visual_hive_verdict_engine");
    expect(result.report.gatingContributions.map((contribution) => contribution.key)).toContain("mutation.mutation_survivor.force-login-on-demo");
    expect(result.report.gatingContributions.every((contribution) => contribution.authority === "gating")).toBe(true);
    expect(result.report.advisoryContributions.some((contribution) => contribution.key.startsWith("triage."))).toBe(false);
    expect(result.report.sourceArtifacts.evidencePacket).toBe(".visual-hive/evidence-packet.json");
    expect(JSON.stringify(result.report)).not.toContain("secret-value");
    expect(JSON.stringify(result.report)).toContain("[REDACTED]");
    expect(await readFile(result.reportPath, "utf8")).toContain("visual-hive.verdict.v1");
    expect(await readFile(result.markdownPath, "utf8")).toContain("Visual Hive Verdict: baseline-fixture");
  });

  it("can build an inconclusive verdict when no evidence artifacts exist yet", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-verdict-empty-"));
    tempDirs.push(rootDir);
    const report = await buildVerdictReport({
      rootDir,
      project: "empty",
      now: new Date("2026-06-15T00:03:00.000Z")
    });

    expect(report.summary.visualHiveVerdict).toBe("inconclusive");
    expect(report.summary.blockedBecause).toContain("playwright.deterministic_run");
    expect(report.sourceArtifacts.evidencePacket).toBeUndefined();
    expect(report.gatingContributions.map((contribution) => contribution.key)).toContain("playwright.deterministic_run");
  });

  it("normalizes legacy Evidence Packet contributions without key or authority", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-verdict-legacy-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), {
      schemaVersion: "visual-hive.evidence-packet.v1",
      generatedAt: "2026-06-15T00:02:00.000Z",
      project: "legacy",
      sourceArtifacts: {},
      governance: {
        verdictAuthority: "visual_hive",
        defaultBrowserBackend: "playwright",
        llmAuthority: "advisory_only",
        providerAuthority: "policy_gated_when_normalized",
        secretPolicy: "redacted_values_names_only"
      },
      repo: {},
      providers: [],
      testingLayers: [],
      evidenceContributions: [
        {
          source: "playwright",
          kind: "deterministic_run",
          status: "failed",
          gating: true,
          reason: "Legacy deterministic failure.",
          artifacts: [".visual-hive/report.json"]
        }
      ],
      verdictSummary: {
        visualHiveVerdict: "failed",
        failedBecause: ["playwright.deterministic_run"],
        warningBecause: [],
        blockedBecause: [],
        advisoryOnly: []
      },
      hiveReadiness: {
        readyForIssueHandoff: true,
        readyForHiveDryRun: true,
        blockedReasons: [],
        suggestedLabels: ["visual-hive"]
      }
    });

    const report = await buildVerdictReport({ rootDir, project: "legacy", now: new Date("2026-06-15T00:03:00.000Z") });

    expect(report.summary.visualHiveVerdict).toBe("failed");
    expect(report.gatingContributions[0]?.key).toBe("playwright.deterministic_run");
    expect(report.gatingContributions[0]?.authority).toBe("gating");
  });
});

describe("testing layer reports", () => {
  it("writes layer coverage, skipped reasons, and recommendations from evidence", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-layers-"));
    tempDirs.push(rootDir);
    const report = reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png");
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), {
      schemaVersion: 1,
      generatedAt: "2026-06-15T00:00:00.000Z",
      repoRoot: ".",
      project: { name: "baseline-fixture", packageManager: "npm", workspaces: [], frameworks: ["react"] },
      packages: [],
      scripts: [],
      sourceSummary: { scannedFiles: 1, truncated: false, extensions: { ".tsx": 1 } },
      selectors: [{ selector: "[data-testid='dashboard-page']", sourceFile: "src/App.tsx", occurrences: 1 }],
      routes: [],
      workflows: [],
      testTools: ["playwright"],
      targetHints: [],
      riskSignals: [{ id: "token", severity: "warning", message: "token=secret-value", evidence: [], recommendation: "Review selector coverage." }],
      coverageGaps: [{ id: "route-coverage", layer: 6, severity: "medium", message: "token=secret-value", suggestedArtifact: "visual-hive.config.yaml" }],
      recommendations: []
    });
    await writeEvidencePacket({
      rootDir,
      project: "baseline-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });

    const result = await writeTestingLayerReport({
      rootDir,
      project: "baseline-fixture",
      now: new Date("2026-06-15T00:03:00.000Z")
    });

    expect(result.report.schemaVersion).toBe(1);
    expect(result.report.outputResource).toMatchObject({
      artifactPath: ".visual-hive/testing-layers.json",
      evidenceResourceId: "testing-layers",
      evidenceResourceUri: "visual-hive://testing-layers",
      evidenceReadToolName: "visual_hive_read_testing_layers"
    });
    expect(result.report.summary.totalLayers).toBe(12);
    expect(result.report.summary.covered).toBeGreaterThan(0);
    expect(result.report.summary.gapCount).toBeGreaterThan(0);
    expect(result.report.layers.find((layer) => layer.id === 0)?.status).toBe("covered");
    expect(result.report.layers.find((layer) => layer.id === 0)?.gaps.join(" ")).toContain("[REDACTED]");
    expect(result.report.layers.find((layer) => layer.id === 9)?.status).toBe("missing");
    expect(result.report.recommendations.join(" ")).toContain("No mutation report found");
    expect(result.report.governance.verdictAuthority).toBe("visual_hive");
    expect(JSON.stringify(result.report)).not.toContain("secret-value");
    expect(JSON.stringify(result.report)).toContain("[REDACTED]");
    expect(await readFile(result.reportPath, "utf8")).toContain('"schemaVersion": 1');
    expect(await readFile(result.reportPath, "utf8")).toContain('"evidenceResourceId": "testing-layers"');
    expect(await readFile(result.markdownPath, "utf8")).toContain("Visual Hive Testing Layers: baseline-fixture");
  });

  it("can build missing evidence status before deterministic artifacts exist", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-layers-empty-"));
    tempDirs.push(rootDir);
    const report = await buildTestingLayerReport({
      rootDir,
      project: "empty",
      now: new Date("2026-06-15T00:03:00.000Z")
    });

    expect(report.summary.status).toBe("missing_evidence");
    expect(report.outputResource).toMatchObject({
      artifactPath: ".visual-hive/testing-layers.json",
      evidenceResourceId: "testing-layers",
      evidenceResourceUri: "visual-hive://testing-layers",
      evidenceReadToolName: "visual_hive_read_testing_layers"
    });
    expect(report.layers.find((layer) => layer.id === 0)?.status).toBe("unknown");
    expect(report.layers.find((layer) => layer.id === 6)?.status).toBe("missing");
    expect(report.sourceArtifacts.evidencePacket).toBeUndefined();
  });
});

describe("test creation plans", () => {
  it("builds a no-write advisory plan from layers, mutation survivors, coverage, and handoff items", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-test-creation-"));
    tempDirs.push(rootDir);
    const evidence = await buildEvidencePacket({
      rootDir,
      project: "test-creation-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });
    const handoff = buildHandoffArtifacts({
      evidencePacket: {
        ...evidence,
        testingLayers: evidence.testingLayers.map((layer) =>
          layer.id === 3
            ? { ...layer, status: "unknown", gaps: ["access_token=layer-secret"] }
            : layer.id === 9
              ? { ...layer, status: "missing", gaps: ["No mutation evidence found."] }
              : layer
        )
      },
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      now: new Date("2026-06-15T00:03:00.000Z")
    });
    const plan = await buildTestCreationPlan({
      project: "test-creation-fixture",
      now: new Date("2026-06-15T00:04:00.000Z"),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      coverageRecommendationsPath: ".visual-hive/coverage-recommendations.json",
      handoffPacketPath: ".visual-hive/handoff.json",
      evidencePacket: {
        testingLayers: handoff.handoff.workItems.length
          ? evidence.testingLayers.map((layer) =>
              layer.id === 3
                ? { ...layer, status: "unknown", gaps: ["access_token=layer-secret"] }
                : layer.id === 9
                  ? { ...layer, status: "missing", gaps: ["No mutation evidence found."] }
                  : layer
            )
          : evidence.testingLayers,
        mutation: {
          survivedOperators: [
            {
              operator: "force-login-on-demo",
              contractIds: ["hosted-demo-never-login"],
              failedAssertion: "client_secret=mutation-secret",
              artifacts: [".visual-hive/mutation-report.json"]
            }
          ]
        }
      },
      coverageRecommendations: {
        recommendations: [
          {
            id: "assertions:dashboard",
            kind: "add_selector_assertion",
            severity: "high",
            title: "Add dashboard selector",
            rationale: ["token=coverage-secret"],
            contractId: "dashboard",
            suggestedTests: ["Add a stable dashboard selector."],
            suggestedConfigYaml: "selectors:\n  mustExist:\n    - \"[data-testid='dashboard-page']\""
          }
        ]
      },
      handoffPacket: handoff.handoff
    });

    expect(plan.schemaVersion).toBe("visual-hive.test-creation-plan.v1");
    expect(plan.outputResource).toEqual({
      artifactPath: ".visual-hive/test-creation-plan.json",
      evidenceResourceId: "test-creation-plan",
      evidenceResourceUri: "visual-hive://test-creation-plan",
      evidenceResourceTitle: "Test Creation Plan",
      evidenceResourceDescription:
        "No-write advisory test-creation recommendations from testing layers, mutation survivors, coverage recommendations, and handoff work.",
      evidenceReadToolName: "visual_hive_read_test_creation_plan"
    });
    expect(plan.governance.writePolicy).toBe("no_config_or_test_files_written");
    expect(plan.summary.total).toBeGreaterThanOrEqual(4);
    expect(plan.summary.fromTestingLayers).toBeGreaterThan(0);
    expect(plan.summary.fromCoverageRecommendations).toBe(1);
    expect(plan.summary.fromMutationSurvivors).toBe(1);
    expect(plan.summary.fromHandoffWorkItems).toBeGreaterThan(0);
    expect(plan.recommendations.map((recommendation) => recommendation.kind)).toEqual(
      expect.arrayContaining(["accessibility_check", "mutation_mapping", "selector_assertion"])
    );
    expect(plan.recommendations.every((recommendation) => recommendation.applyMode === "advisory_no_write")).toBe(true);
    expect(
      plan.recommendations.every(
        (recommendation) =>
          recommendation.gapId &&
          Object.keys(recommendation.affected).length > 0 &&
          recommendation.currentEvidence.length > 0 &&
          recommendation.suggestedContract.route &&
          recommendation.suggestedContract.selectors.length > 0 &&
          recommendation.suggestedMutation &&
          recommendation.validationCommand.startsWith("visual-hive ") &&
          ["quality", "tester", "ci-maintainer"].includes(recommendation.hiveOwner)
      )
    ).toBe(true);
    const mutationRecommendation = plan.recommendations.find((recommendation) => recommendation.source === "mutation_survivor");
    expect(mutationRecommendation).toMatchObject({
      gapId: "mutation:force-login-on-demo",
      affected: {
        route: "/",
        component: "auth-boundary",
        state: "public-demo"
      },
      suggestedMutation: "force-login-on-demo",
      validationCommand: "visual-hive mutate --config visual-hive.config.yaml --enforce-min-score",
      hiveOwner: "quality"
    });
    expect(mutationRecommendation?.suggestedContract.selectors).toEqual(
      expect.arrayContaining(["[data-testid='dashboard-page']", "not:[data-testid='login-page']"])
    );
    const coverageRecommendation = plan.recommendations.find((recommendation) => recommendation.source === "coverage_recommendation");
    expect(coverageRecommendation?.gapId).toBe("assertions:dashboard");
    expect(coverageRecommendation?.affected.component).toBe("dashboard-shell");
    expect(coverageRecommendation?.hiveOwner).toBe("tester");
    const serialized = JSON.stringify(plan);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("layer-secret");
    expect(serialized).not.toContain("mutation-secret");
    expect(serialized).not.toContain("coverage-secret");
  });

  it("writes JSON and Markdown test creation plan artifacts", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-test-creation-write-"));
    tempDirs.push(rootDir);
    const evidence = await buildEvidencePacket({
      rootDir,
      project: "test-creation-write",
      now: new Date("2026-06-15T00:02:00.000Z")
    });
    const result = await writeTestCreationPlan({
      rootDir,
      project: "test-creation-write",
      evidencePacket: {
        testingLayers: evidence.testingLayers.map((layer) => (layer.id === 2 ? { ...layer, status: "unknown", gaps: ["No unit evidence found."] } : layer))
      },
      now: new Date("2026-06-15T00:04:00.000Z")
    });

    expect(result.planPath).toMatch(/test-creation-plan\.json$/);
    expect(result.markdownPath).toMatch(/test-creation-plan\.md$/);
    const writtenPlan = await readFile(result.planPath, "utf8");
    expect(writtenPlan).toContain("visual-hive.test-creation-plan.v1");
    expect(writtenPlan).toContain("visual-hive://test-creation-plan");
    expect(await readFile(result.markdownPath, "utf8")).toContain("Visual Hive Test Creation Plan: test-creation-write");
  });
});

describe("handoff packets", () => {
  it("derives a no-network Hive handoff from a failed Evidence Packet", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-handoff-"));
    tempDirs.push(rootDir);
    const report = reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png");
    report.results[0]?.errors.push("authorization: bearer-secret-value");
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);
    const mutationReport: MutationReport = {
      schemaVersion: 2,
      project: "baseline-fixture",
      generatedAt: "2026-06-15T00:01:00.000Z",
      minScore: 0.75,
      score: 0.5,
      killed: 1,
      total: 2,
      results: [
        {
          operator: "force-login-on-demo",
          status: "survived",
          killed: false,
          contractIds: ["dashboard"],
          applicable: true,
          failedAssertion: "token=secret-token-value",
          durationMs: 10,
          errors: [],
          artifacts: [".visual-hive/mutation-report.json"]
        }
      ]
    };
    await writeJson(path.join(rootDir, ".visual-hive", "mutation-report.json"), mutationReport);
    const evidence = await writeEvidencePacket({ rootDir, project: "baseline-fixture", now: new Date("2026-06-15T00:02:00.000Z") });
    const handoff = await writeHandoffArtifacts({
      rootDir,
      evidencePacket: evidence.packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      labels: ["visual-hive", "hive/quality", "ai-ready", "custom"],
      now: new Date("2026-06-15T00:03:00.000Z")
    });

    expect(handoff.handoff.schemaVersion).toBe("visual-hive.handoff.v1");
    expect(handoff.handoff.status).toBe("ready");
    expect(handoff.handoff.externalCallsMade).toBe(0);
    expect(handoff.handoff.workItems.map((item) => item.kind)).toEqual(expect.arrayContaining(["repair", "test_creation"]));
    expect(handoff.beadRequest.dryRun).toBe(true);
    expect(handoff.beadRequest.target).toMatchObject({
      integrationEnabled: false,
      configuredMode: "dry_run",
      tokenEnv: "HIVE_DASHBOARD_TOKEN",
      tokenPresent: false,
      missingTokenEnv: "HIVE_DASHBOARD_TOKEN"
    });
    expect(handoff.handoff.hiveBeadRequest).toMatchObject({
      integrationEnabled: false,
      configuredMode: "dry_run",
      tokenEnv: "HIVE_DASHBOARD_TOKEN",
      tokenPresent: false,
      missingTokenEnv: "HIVE_DASHBOARD_TOKEN"
    });
    expect(handoff.beadRequest.forbiddenActions).toContain("decide_visual_hive_verdict");
    expect(handoff.result.status).toBe("dry_run_written");
    expect(handoff.issueBody).toContain("Visual Hive's deterministic Verdict Engine owns pass/fail.");
    expect(handoff.issueBody).toContain(`Dedupe fingerprint: ${handoff.handoff.githubIssue.dedupeSignature}`);
    expect(handoff.issueBody).toContain("## Failing Contracts");
    expect(handoff.issueBody).toContain("dashboard on local");
    expect(handoff.issueBody).toContain("## Affected Surface");
    expect(handoff.issueBody).toContain("contract=dashboard");
    expect(handoff.issueBody).toContain("route=/");
    expect(handoff.issueBody).toContain("viewport=desktop");
    expect(handoff.issueBody).toContain("selectors=see .visual-hive/report.json selectorAssertions");
    expect(handoff.issueBody).toContain("components=see .visual-hive/repo-map.json visual map");
    expect(handoff.issueBody).toContain("## Screenshot And Diff Evidence");
    expect(handoff.issueBody).toContain("baseline=.visual-hive/snapshots/dashboard.png");
    expect(handoff.issueBody).toContain("actual=.visual-hive/artifacts/screenshots/dashboard.png");
    expect(handoff.issueBody).toContain("## Mutation Evidence");
    expect(handoff.issueBody).toContain("survived force-login-on-demo");
    expect(handoff.issueBody).toContain("## Evidence Resources");
    expect(handoff.issueBody).toContain("Test Creation Plan: .visual-hive/test-creation-plan.json");
    expect(handoff.issueBody).toContain("Hive native export: .visual-hive/hive/hive-export.json");
    expect(handoff.issueBody).toContain("Hive knowledge graph: .visual-hive/hive/knowledge-graph.json");
    expect(handoff.issueBody).toContain("Hive repair work orders: .visual-hive/hive/repair-work-orders.json");
    expect(handoff.issueBody).toContain("## Visual Map References");
    expect(handoff.issueBody).toContain("contract:dashboard");
    expect(handoff.issueBody).toContain("mutation:force-login-on-demo");
    expect(handoff.issueBody).toContain("## Validation Commands");
    expect(handoff.issueBody).toContain("visual-hive handoff-validate");
    expect(handoff.issueBody).toContain("visual-hive hive export --dry-run --mode repair_request");
    expect(handoff.issueBody).toContain("After Hive repairs code/tests, rerun `visual-hive pipeline --mode pr --ci`");
    expect(handoff.issueBody).toContain("Do not blindly approve baselines");
    expect(handoff.issueBody).toContain("Do not weaken screenshot thresholds");
    expect(handoff.issueBody).toContain("Do not treat LLM/Hive judgment as the Visual Hive verdict.");
    expect(handoff.issueBody).toContain("Rerun Visual Hive after every repair");
    const sameFailureHandoff = buildHandoffArtifacts({
      evidencePacket: evidence.packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      labels: ["visual-hive", "hive/quality", "ai-ready", "custom"],
      now: new Date("2026-06-15T01:03:00.000Z")
    });
    expect(sameFailureHandoff.handoff.githubIssue.dedupeSignature).toBe(handoff.handoff.githubIssue.dedupeSignature);
    expect(JSON.stringify(handoff)).not.toContain("secret-token-value");
    expect(JSON.stringify(handoff)).not.toContain("bearer-secret-value");
    expect(JSON.stringify(handoff)).toContain("[REDACTED]");
    expect(await readFile(handoff.handoffPath, "utf8")).toContain("visual-hive.handoff.v1");
    expect(await readFile(handoff.issuePath, "utf8")).toContain("visual-hive-hive-handoff");
    expect(await readFile(handoff.beadRequestPath, "utf8")).toContain("visual-hive.hive-bead-request.v1");
    expect(await readFile(handoff.resultPath, "utf8")).toContain("visual-hive.hive-handoff-result.v1");

    const validation = await validateHandoffArtifacts({
      rootDir,
      now: new Date("2026-06-15T00:04:00.000Z")
    });
    expect(validation.report.schemaVersion).toBe("visual-hive.handoff-validation.v1");
    expect(validation.report.status).not.toBe("blocked");
    expect(validation.report.blockedReasons).toEqual([]);
    expect(validation.report.summary.externalCallsMade).toBe(0);
    expect(validation.report.hiveReadiness.fullAutomationBlocked).toBe(true);
    expect(validation.report.hiveReadiness.guardedRepairTrustedOnlyOrBlocked).toBe(true);
    expect(validation.report.hiveReadiness.blockedModes).toContain("full");
    expect(validation.report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "no-external-calls",
        "dry-run-policy",
        "verdict-consistency",
        "issue-body-sanitized",
        "hive-readiness-schema",
        "hive-recommendation-policy",
        "hive-guarded-policy"
      ])
    );
    expect(await readFile(validation.reportPath, "utf8")).toContain("visual-hive.handoff-validation.v1");
  });

  it("blocks Hive handoff validation when Evidence Packet Hive readiness violates guarded repair policy", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-handoff-validation-readiness-"));
    tempDirs.push(rootDir);
    const packet = await buildEvidencePacket({
      rootDir,
      project: "validation-readiness",
      now: new Date("2026-06-15T00:02:00.000Z")
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), packet);
    await writeHandoffArtifacts({
      rootDir,
      evidencePacket: packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      now: new Date("2026-06-15T00:03:00.000Z")
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), {
      ...packet,
      hiveReadiness: {
        ...packet.hiveReadiness,
        recommendedMode: "full",
        recommendationReason: "Unsafe test fixture that should be rejected.",
        modeReadiness: packet.hiveReadiness.modeReadiness
          .filter((entry) => entry.mode !== "guarded_repair")
          .map((entry) =>
            entry.mode === "full"
              ? {
                  ...entry,
                  status: "ready",
                  trustedWorkflowRequired: false,
                  blockedReasons: [],
                  nextCommand: "visual-hive hive export --mode full"
                }
              : entry
          )
      }
    });

    const validation = await validateHandoffArtifacts({
      rootDir,
      now: new Date("2026-06-15T00:04:00.000Z")
    });
    expect(validation.report.status).toBe("blocked");
    expect(validation.report.hiveReadiness.recommendedMode).toBe("full");
    expect(validation.report.hiveReadiness.fullAutomationBlocked).toBe(false);
    expect(validation.report.hiveReadiness.guardedRepairTrustedOnlyOrBlocked).toBe(false);
    expect(validation.report.blockedReasons.join(" ")).toContain("hive-readiness-schema");
    expect(validation.report.blockedReasons.join(" ")).toContain("hive-recommendation-policy");
    expect(validation.report.blockedReasons.join(" ")).toContain("hive-guarded-policy");
  });

  it("validates optional Hive trusted repair chain artifacts when they are present", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-handoff-validation-hive-chain-"));
    tempDirs.push(rootDir);
    const packet = await buildEvidencePacket({
      rootDir,
      project: "validation-hive-chain",
      now: new Date("2026-06-15T00:02:00.000Z")
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), packet);
    const handoff = await writeHandoffArtifacts({
      rootDir,
      evidencePacket: packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      now: new Date("2026-06-15T00:03:00.000Z")
    });
    const hiveExport = await writeHiveExportArtifacts({
      rootDir,
      evidencePacket: packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      handoffPacket: handoff.handoff,
      handoffPacketPath: ".visual-hive/handoff.json",
      hiveConfig: { mode: "repair_request" },
      now: new Date("2026-06-15T00:04:00.000Z")
    });
    const guardedRepairPreview = await writeHiveGuardedRepairPreview({
      rootDir,
      hiveExport: hiveExport.bundle,
      hiveExportPath: ".visual-hive/hive/hive-export.json",
      now: new Date("2026-06-15T00:05:00.000Z")
    });
    const repairRequestEnvelope = await writeHiveRepairRequestEnvelope({
      rootDir,
      guardedRepairPreview: guardedRepairPreview.preview,
      guardedRepairPreviewPath: ".visual-hive/hive/guarded-repair-preview.json",
      now: new Date("2026-06-15T00:06:00.000Z")
    });
    const trustedRepairConsumerSummary = await writeHiveTrustedRepairConsumerSummary({
      rootDir,
      repairRequestEnvelope: repairRequestEnvelope.envelope,
      repairRequestEnvelopePath: ".visual-hive/hive/repair-request-envelope.json",
      now: new Date("2026-06-15T00:07:00.000Z")
    });
    await writeHiveTrustedRepairWorkflowDryRun({
      rootDir,
      trustedRepairConsumerSummary: trustedRepairConsumerSummary.summary,
      trustedRepairConsumerSummaryPath: ".visual-hive/hive/trusted-repair-consumer-summary.json",
      now: new Date("2026-06-15T00:08:00.000Z")
    });

    const validation = await validateHandoffArtifacts({
      rootDir,
      now: new Date("2026-06-15T00:09:00.000Z")
    });

    expect(validation.report.status).not.toBe("blocked");
    expect(validation.report.blockedReasons).toEqual([]);
    expect(validation.report.summary.externalCallsMade).toBe(0);
    expect(validation.report.sourceArtifacts).toMatchObject({
      hiveExport: ".visual-hive/hive/hive-export.json",
      guardedRepairPreview: ".visual-hive/hive/guarded-repair-preview.json",
      repairRequestEnvelope: ".visual-hive/hive/repair-request-envelope.json",
      trustedRepairConsumerSummary: ".visual-hive/hive/trusted-repair-consumer-summary.json",
      trustedRepairWorkflowDryRun: ".visual-hive/hive/trusted-repair-workflow-dry-run.json"
    });
    expect(validation.report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "hive-export-schema",
        "hive-guarded-repair-preview-schema",
        "hive-repair-request-envelope-schema",
        "hive-trusted-repair-consumer-summary-schema",
        "hive-trusted-repair-consumer-policy",
        "hive-trusted-repair-workflow-dry-run-schema",
        "hive-trusted-repair-workflow-dry-run-policy",
        "hive-trusted-repair-chain-consistency"
      ])
    );
    await expectMatchesSchema("visual-hive.handoff-validation.schema.json", validation.report);
    expect(JSON.stringify(validation.report)).not.toContain("secret-value");
  });

  it("blocks Hive handoff validation when artifacts claim external calls", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-handoff-validation-blocked-"));
    tempDirs.push(rootDir);
    const packet = await buildEvidencePacket({
      rootDir,
      project: "validation-blocked",
      now: new Date("2026-06-15T00:02:00.000Z")
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), packet);
    const handoff = await writeHandoffArtifacts({
      rootDir,
      evidencePacket: packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      now: new Date("2026-06-15T00:03:00.000Z")
    });
    await writeJson(path.join(rootDir, ".visual-hive", "hive-bead-request.json"), {
      ...handoff.beadRequest,
      project: "validation-blocked?token=secret-value",
      externalCallsMade: 1,
      objective: "authorization: Bearer secret-value"
    });

    const validation = await validateHandoffArtifacts({
      rootDir,
      now: new Date("2026-06-15T00:04:00.000Z")
    });
    expect(validation.report.status).toBe("blocked");
    expect(validation.report.summary.externalCallsMade).toBe(1);
    expect(validation.report.blockedReasons.join(" ")).toContain("no-external-calls");
    const serialized = JSON.stringify(validation.report);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("secret-value");
  });

  it("blocks non-dry-run modes while still writing local review artifacts", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-handoff-blocked-"));
    tempDirs.push(rootDir);
    const packet = await buildEvidencePacket({
      rootDir,
      project: "empty",
      now: new Date("2026-06-15T00:02:00.000Z")
    });
    const artifacts = buildHandoffArtifacts({
      evidencePacket: packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      mode: "bead_api",
      hiveIntegration: {
        enabled: true,
        mode: "bead_api",
        beadApi: {
          url: "https://hive.example.invalid/api/beads?token=secret-value",
          tokenEnv: "HIVE_DASHBOARD_TOKEN",
          agent: "quality",
          tokenPresent: false
        }
      },
      now: new Date("2026-06-15T00:03:00.000Z")
    });
    expect(artifacts.handoff.status).toBe("blocked");
    expect(artifacts.handoff.blockedReasons.join(" ")).toContain("Only dry-run handoff is implemented locally");
    expect(artifacts.handoff.blockedReasons.join(" ")).toContain("Hive bead API token environment variable is missing: HIVE_DASHBOARD_TOKEN");
    expect(artifacts.handoff.hiveBeadRequest).toMatchObject({
      integrationEnabled: true,
      configuredMode: "bead_api",
      beadApiUrl: "https://hive.example.invalid/api/beads?token=[REDACTED]",
      tokenEnv: "HIVE_DASHBOARD_TOKEN",
      tokenPresent: false,
      missingTokenEnv: "HIVE_DASHBOARD_TOKEN"
    });
    expect(artifacts.beadRequest.target).toMatchObject({
      integrationEnabled: true,
      configuredMode: "bead_api",
      beadApiUrl: "https://hive.example.invalid/api/beads?token=[REDACTED]",
      tokenEnv: "HIVE_DASHBOARD_TOKEN",
      tokenPresent: false,
      missingTokenEnv: "HIVE_DASHBOARD_TOKEN"
    });
    expect(artifacts.result.externalCallsMade).toBe(0);
    expect(JSON.stringify(artifacts)).not.toContain("secret-value");
  });

  it("turns testing-layer gaps into bounded handoff work items", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-handoff-layers-"));
    tempDirs.push(rootDir);
    const packet = await buildEvidencePacket({
      rootDir,
      project: "layer-gap-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });
    const artifacts = buildHandoffArtifacts({
      evidencePacket: {
        ...packet,
        testingLayers: packet.testingLayers.map((layer) =>
          layer.id === 2
            ? {
                ...layer,
                status: "unknown",
                gaps: ["Unit test evidence is missing; token=layer-secret"]
              }
            : layer.id === 9
              ? {
                  ...layer,
                  status: "missing",
                  gaps: ["No mutation report found."]
                }
              : layer
        )
      },
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      now: new Date("2026-06-15T00:03:00.000Z")
    });

    expect(artifacts.handoff.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "testing-layer-2-unknown",
          kind: "test_creation",
          title: "Add Unit evidence"
        }),
        expect.objectContaining({
          id: "testing-layer-9-missing",
          kind: "test_creation",
          title: "Add Mutation/fault injection evidence"
        })
      ])
    );
    expect(artifacts.issueBody).toContain("testing_layer.9.missing");
    expect(JSON.stringify(artifacts)).toContain("[REDACTED]");
    expect(JSON.stringify(artifacts)).not.toContain("layer-secret");
  });
});

describe("agent packets", () => {
  it("builds a sanitized repair packet from Evidence and Handoff artifacts", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-agent-packet-"));
    tempDirs.push(rootDir);
    const report = reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png");
    report.results[0]?.errors.push("token=agent-secret-value");
    report.providerResults = [
      {
        providerId: "argos",
        label: "Argos",
        status: "failed",
        deterministicRole: "supplemental",
        message: "Argos upload failed without changing the Visual Hive verdict.",
        requiredEnv: ["ARGOS_TOKEN"],
        missingEnv: [],
        artifactCount: 2,
        upload: {
          status: "failed",
          externalCallsMade: 1,
          stagedArtifacts: 2,
          uploadedArtifacts: 0,
          manifestPath: ".visual-hive/provider-upload/argos/manifest.json",
          uploadDirectory: ".visual-hive/provider-upload/argos",
          providerUrl: "https://app.argos-ci.com/build?token=agent-provider-secret",
          blockedReasons: ["authorization: Bearer agent-provider-secret"]
        },
        normalizedAt: "2026-06-15T00:01:00.000Z"
      }
    ];
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);
    const mutationReport: MutationReport = {
      schemaVersion: 2,
      project: "baseline-fixture",
      generatedAt: "2026-06-15T00:01:00.000Z",
      minScore: 0.75,
      score: 0.5,
      killed: 1,
      total: 2,
      results: [
        {
          operator: "force-login-on-demo",
          status: "survived",
          killed: false,
          contractIds: ["dashboard"],
          applicable: true,
          failedAssertion: "client_secret=agent-mutation-secret",
          durationMs: 10,
          errors: [],
          artifacts: [".visual-hive/mutation-report.json"]
        }
      ]
    };
    await writeJson(path.join(rootDir, ".visual-hive", "mutation-report.json"), mutationReport);
    const runHistory = createRunHistoryReport({
      project: "baseline-fixture",
      generatedAt: "2026-06-15T00:01:30.000Z",
      entries: [
        createRunHistoryEntry({
          repoRoot: rootDir,
          id: "latest",
          recordedAt: "2026-06-15T00:01:30.000Z",
          files: {
            report: ".visual-hive/report.json",
            mutationReport: ".visual-hive/mutation-report.json"
          },
          report,
          mutationReport
        })
      ]
    });

    const evidence = await writeEvidencePacket({ rootDir, project: "baseline-fixture", now: new Date("2026-06-15T00:02:00.000Z") });
    const handoff = await writeHandoffArtifacts({
      rootDir,
      evidencePacket: evidence.packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      now: new Date("2026-06-15T00:03:00.000Z")
    });
    const result = await writeAgentPacket({
      rootDir,
      evidencePacket: evidence.packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      handoffPacket: handoff.handoff,
      handoffPacketPath: ".visual-hive/handoff.json",
      profile: "repair_agent",
      now: new Date("2026-06-15T00:04:00.000Z")
    });

    expect(result.packet.schemaVersion).toBe("visual-hive.agent-packet.v1");
    expect(result.packet.profile).toBe("repair_agent");
    expect(result.packet.objective).toContain("Repair Visual Hive failure");
    expect(result.packet.verdict.visualHiveVerdict).toBe("failed");
    expect(result.packet.allowedTools.map((tool) => tool.id)).toContain("visual_hive_read_evidence_packet");
    expect(result.packet.allowedTools.find((tool) => tool.id === "visual_hive_read_evidence_packet")).toMatchObject({
      evidenceResourceId: "latest-evidence",
      evidenceResourceUri: "visual-hive://latest-evidence",
      evidenceResourceTitle: "Latest Evidence Packet",
      evidenceReadToolName: "visual_hive_read_evidence_packet",
      artifactPath: ".visual-hive/evidence-packet.json"
    });
    expect(result.packet.allowedTools.find((tool) => tool.id === "visual_hive_read_triage_report")).toMatchObject({
      evidenceResourceId: "triage-report",
      evidenceResourceUri: "visual-hive://triage-report",
      evidenceReadToolName: "visual_hive_read_triage_report",
      artifactPath: ".visual-hive/triage.json"
    });
    expect(result.packet.allowedTools.find((tool) => tool.id === "visual_hive_generate_repair_prompt")).toMatchObject({
      evidenceResourceId: "repair-prompt",
      evidenceResourceUri: "visual-hive://repair-prompt",
      evidenceReadToolName: "visual_hive_generate_repair_prompt",
      artifactPath: ".visual-hive/repair-prompt.md"
    });
    expect(result.packet.allowedTools.find((tool) => tool.id === "visual_hive_read_missing_tests")).toMatchObject({
      evidenceResourceId: "missing-tests",
      evidenceResourceUri: "visual-hive://missing-tests",
      evidenceReadToolName: "visual_hive_read_missing_tests",
      artifactPath: ".visual-hive/missing-tests.md"
    });
    expect(result.packet.forbiddenActions).toContain("decide_visual_hive_verdict");
    expect(result.packet.governance.verdictAuthority).toBe("visual_hive");
    expect(result.packet.governance.agentAuthority).toBe("advisory_repair_only");
    expect(result.packet.budgets.allowExternalNetwork).toBe(false);
    expect(result.packet.budgets.maxExternalCostUsd).toBe(0);
    expect(result.packet.evidenceSummary.testingLayers.map((layer) => layer.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(result.packet.evidenceSummary.providerEvidence[0]).toMatchObject({
      providerId: "argos",
      uploadStatus: "failed",
      externalCallsMade: 1,
      stagedArtifacts: 2,
      manifestPath: ".visual-hive/provider-upload/argos/manifest.json"
    });
    expect(result.packet.artifactPointers).toEqual(expect.arrayContaining([".visual-hive/evidence-packet.json", ".visual-hive/handoff.json", ".visual-hive/report.json"]));
    expect(result.packet.artifactPointers).toEqual(expect.arrayContaining([".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"]));
    expect(JSON.stringify(result.packet)).not.toContain("agent-secret-value");
    expect(JSON.stringify(result.packet)).not.toContain("agent-mutation-secret");
    expect(JSON.stringify(result.packet)).not.toContain("agent-provider-secret");
    expect(JSON.stringify(result.packet)).not.toContain(rootDir.replaceAll("\\", "\\\\"));
    expect(JSON.stringify(result.packet)).not.toContain(rootDir.replaceAll("\\", "/"));
    expect(JSON.stringify(result.packet)).toContain("[REDACTED]");
    expect(await readFile(result.packetPath, "utf8")).toContain("visual-hive.agent-packet.v1");

    const handoffPacket = buildAgentPacket({
      evidencePacket: evidence.packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      handoffPacket: handoff.handoff,
      handoffPacketPath: ".visual-hive/handoff.json",
      profile: "handoff_agent",
      now: new Date("2026-06-15T00:05:00.000Z")
    });
    expect(handoffPacket.profile).toBe("handoff_agent");
    expect(handoffPacket.objective).toContain("Prepare trusted handoff");
    expect(handoffPacket.allowedTools.map((tool) => tool.id)).toEqual(
      expect.arrayContaining([
        "visual_hive_generate_handoff_dry_run",
        "visual_hive_validate_handoff",
        "visual_hive_read_triage_report",
        "visual_hive_read_issue_body",
        "visual_hive_read_pr_comment",
        "visual_hive_read_missing_tests",
        "visual_hive_read_hive_export",
        "visual_hive_read_hive_beads",
        "visual_hive_read_hive_knowledge_facts",
        "visual_hive_read_hive_knowledge_graph",
        "visual_hive_read_hive_repair_work_orders",
        "visual_hive_read_hive_agent_policy",
        "visual_hive_read_hive_guarded_repair_preview",
        "visual_hive_read_hive_repair_request_envelope",
        "visual_hive_read_hive_trusted_repair_consumer_summary",
        "visual_hive_read_hive_trusted_repair_workflow_dry_run",
        "visual_hive_read_hive_mode_comparison"
      ])
    );
    expect(handoffPacket.allowedTools.find((tool) => tool.id === "visual_hive_read_hive_trusted_repair_workflow_dry_run")).toMatchObject({
      evidenceResourceId: "hive-trusted-repair-workflow-dry-run",
      evidenceResourceUri: "visual-hive://hive-trusted-repair-workflow-dry-run",
      evidenceReadToolName: "visual_hive_read_hive_trusted_repair_workflow_dry_run",
      artifactPath: ".visual-hive/hive/trusted-repair-workflow-dry-run.json"
    });
    expect(handoffPacket.allowedTools.find((tool) => tool.id === "visual_hive_read_issue_body")).toMatchObject({
      evidenceResourceId: "issue-body",
      evidenceResourceUri: "visual-hive://issue-body",
      evidenceReadToolName: "visual_hive_read_issue_body",
      artifactPath: ".visual-hive/issue.md"
    });
    expect(handoffPacket.allowedTools.find((tool) => tool.id === "visual_hive_read_pr_comment")).toMatchObject({
      evidenceResourceId: "pr-comment",
      evidenceResourceUri: "visual-hive://pr-comment",
      evidenceReadToolName: "visual_hive_read_pr_comment",
      artifactPath: ".visual-hive/pr-comment.md"
    });
    expect(handoffPacket.allowedTools.find((tool) => tool.id === "visual_hive_read_hive_mode_comparison")).toMatchObject({
      evidenceResourceId: "hive-mode-comparison",
      evidenceResourceUri: "visual-hive://hive-mode-comparison",
      evidenceReadToolName: "visual_hive_read_hive_mode_comparison",
      artifactPath: ".visual-hive/hive/mode-comparison.json"
    });
    expect(handoffPacket.forbiddenActions).toEqual(expect.arrayContaining(["create_github_issue_from_untrusted_pr", "create_hive_bead_without_trusted_workflow"]));
    expect(handoffPacket.budgets.allowExternalNetwork).toBe(false);
    expect(handoffPacket.budgets.maxExternalCostUsd).toBe(0);
    await expectMatchesSchema("visual-hive.agent-packet.schema.json", handoffPacket);

    const providerPacket = buildAgentPacket({
      evidencePacket: evidence.packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      handoffPacket: handoff.handoff,
      handoffPacketPath: ".visual-hive/handoff.json",
      profile: "provider_specialist",
      now: new Date("2026-06-15T00:06:00.000Z")
    });
    expect(providerPacket.profile).toBe("provider_specialist");
    expect(providerPacket.objective).toContain("Review optional provider evidence");
    expect(providerPacket.allowedTools.map((tool) => tool.id)).toEqual(
      expect.arrayContaining([
        "visual_hive_read_provider_decisions",
        "visual_hive_read_provider_setup_plan",
        "visual_hive_read_provider_handoff",
        "visual_hive_read_provider_results",
        "visual_hive_read_provider_upload_manifest",
        "visual_hive_read_provider_agent_packet",
        "visual_hive_provider_handoff_dry_run"
      ])
    );
    expect(providerPacket.allowedTools.find((tool) => tool.id === "visual_hive_read_provider_decisions")).toMatchObject({
      evidenceResourceId: "provider-decisions",
      evidenceResourceUri: "visual-hive://provider-decisions",
      evidenceReadToolName: "visual_hive_read_provider_decisions",
      artifactPath: ".visual-hive/provider-decisions.json"
    });
    expect(providerPacket.allowedTools.find((tool) => tool.id === "visual_hive_read_provider_agent_packet")).toMatchObject({
      evidenceResourceId: "provider-agent-packet",
      evidenceResourceUri: "visual-hive://provider-agent-packet",
      evidenceReadToolName: "visual_hive_read_provider_agent_packet",
      artifactPath: ".visual-hive/provider-agent-packet.json"
    });
    expect(providerPacket.allowedTools.find((tool) => tool.id === "visual_hive_read_provider_upload_manifest")).toMatchObject({
      evidenceResourceId: "provider-upload-argos-manifest",
      evidenceResourceUri: "visual-hive://provider-upload/argos/manifest",
      evidenceReadToolName: "visual_hive_read_provider_upload_manifest",
      artifactPath: ".visual-hive/provider-upload/argos/manifest.json"
    });
    expect(providerPacket.forbiddenActions).toEqual(expect.arrayContaining(["make_provider_gating_by_default", "upload_provider_artifacts_without_trusted_policy"]));
    expect(providerPacket.budgets.allowExternalNetwork).toBe(false);
    expect(providerPacket.budgets.maxExternalCostUsd).toBe(0);
    expect(providerPacket.reproductionCommands).toEqual(expect.arrayContaining(["visual-hive providers upload --provider argos --dry-run"]));
    await expectMatchesSchema("visual-hive.agent-packet.schema.json", providerPacket);

    const reviewPacket = buildAgentPacket({
      evidencePacket: evidence.packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      handoffPacket: handoff.handoff,
      handoffPacketPath: ".visual-hive/handoff.json",
      runHistory,
      runHistoryPath: ".visual-hive/history.json",
      profile: "review_agent",
      now: new Date("2026-06-15T00:07:00.000Z")
    });
    expect(reviewPacket.profile).toBe("review_agent");
    expect(reviewPacket.sourceArtifacts.runHistory).toBe(".visual-hive/history.json");
    const runHistoryResource = VISUAL_HIVE_EVIDENCE_RESOURCES.find((resource) => resource.id === "run-history");
    expect(reviewPacket.evidenceSummary.runHistory).toMatchObject({
      artifactPath: runHistoryResource?.relativePath,
      evidenceResourceId: runHistoryResource?.id,
      evidenceResourceUri: runHistoryResource?.uri,
      evidenceReadToolName: runHistoryResource?.readTool?.name,
      authority: "trend_evidence_only",
      runCount: 1,
      latestStatus: "failed",
      latestMutationScore: 0.5,
      trendDirection: "unknown"
    });
    expect(reviewPacket.allowedTools.find((tool) => tool.id === "visual_hive_read_run_history")).toMatchObject({
      evidenceResourceId: "run-history",
      evidenceResourceUri: "visual-hive://run-history",
      evidenceReadToolName: "visual_hive_read_run_history",
      artifactPath: ".visual-hive/history.json"
    });
    expect(reviewPacket.allowedTools.find((tool) => tool.id === "visual_hive_read_triage_prompt")).toMatchObject({
      evidenceResourceId: "triage-prompt",
      evidenceResourceUri: "visual-hive://triage-prompt",
      evidenceReadToolName: "visual_hive_read_triage_prompt",
      artifactPath: ".visual-hive/triage-prompt.md"
    });
    expect(reviewPacket.forbiddenActions).toContain("decide_visual_hive_verdict");
    expect(reviewPacket.budgets.allowExternalNetwork).toBe(false);
    await expectMatchesSchema("visual-hive.agent-packet.schema.json", reviewPacket);
  }, 15_000);

  it("scopes test creator packets to mutation survivors", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-agent-test-"));
    tempDirs.push(rootDir);
    const evidence = await buildEvidencePacket({
      rootDir,
      project: "empty",
      now: new Date("2026-06-15T00:02:00.000Z")
    });
    const packet = buildAgentPacket({
      evidencePacket: {
        ...evidence,
        mutation: {
          schemaVersion: 2,
          project: "empty",
          generatedAt: "2026-06-15T00:01:00.000Z",
          minScore: 0.75,
          score: 0,
          killed: 0,
          total: 1,
          survivedOperators: [
            {
              operator: "remove-demo-badge",
              contractIds: ["card-demo-badge-contract"],
              failedAssertion: "Mutation survived",
              artifacts: [".visual-hive/mutation-report.json"]
            }
          ],
          notApplicableOperators: []
        }
      },
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      profile: "test_creator",
      now: new Date("2026-06-15T00:04:00.000Z")
    });

    expect(packet.profile).toBe("test_creator");
    expect(packet.allowedTools.find((tool) => tool.id === "visual_hive_read_missing_tests")).toMatchObject({
      evidenceResourceId: "missing-tests",
      evidenceResourceUri: "visual-hive://missing-tests",
      evidenceReadToolName: "visual_hive_read_missing_tests",
      artifactPath: ".visual-hive/missing-tests.md"
    });
    expect(packet.allowedTools.map((tool) => tool.id)).toContain("visual_hive_read_testing_layers");
    expect(packet.allowedTools.find((tool) => tool.id === "visual_hive_read_testing_layers")).toMatchObject({
      evidenceResourceId: "testing-layers",
      evidenceResourceUri: "visual-hive://testing-layers",
      evidenceReadToolName: "visual_hive_read_testing_layers",
      artifactPath: ".visual-hive/testing-layers.json"
    });
    expect(packet.allowedTools.map((tool) => tool.id)).toContain("visual_hive_read_coverage_recommendations");
    expect(packet.allowedTools.find((tool) => tool.id === "visual_hive_read_coverage_recommendations")).toMatchObject({
      evidenceResourceId: "coverage-recommendations",
      evidenceResourceUri: "visual-hive://coverage-recommendations",
      evidenceReadToolName: "visual_hive_read_coverage_recommendations",
      artifactPath: ".visual-hive/coverage-recommendations.json"
    });
    expect(packet.allowedTools.map((tool) => tool.id)).toContain("visual_hive_read_test_creation_plan");
    expect(packet.allowedTools.find((tool) => tool.id === "visual_hive_read_test_creation_plan")).toMatchObject({
      evidenceResourceId: "test-creation-plan",
      evidenceResourceUri: "visual-hive://test-creation-plan",
      evidenceReadToolName: "visual_hive_read_test_creation_plan",
      artifactPath: ".visual-hive/test-creation-plan.json"
    });
    expect(packet.objective).toContain("Improve Visual Hive test adequacy");
    expect(packet.allowedTools.map((tool) => tool.id)).toContain("visual_hive_read_mutation_report");
    expect(packet.allowedTools.find((tool) => tool.id === "visual_hive_read_mutation_report")).toMatchObject({
      evidenceResourceId: "mutation-report",
      evidenceResourceUri: "visual-hive://mutation-report",
      evidenceReadToolName: "visual_hive_read_mutation_report",
      artifactPath: ".visual-hive/mutation-report.json"
    });
    expect(packet.evidenceSummary.workItems[0]).toMatchObject({
      kind: "test_creation",
      title: "Add contract coverage for remove-demo-badge"
    });
    expect(packet.reproductionCommands).toEqual(expect.arrayContaining(["visual-hive mutate", "visual-hive improve-coverage"]));
  });

  it("keeps Agent Packet evidence-resource schema enums aligned with the core catalog", async () => {
    type StringEnumProperty = { enum?: string[] };
    type AgentPacketSchema = {
      properties?: {
        allowedTools?: {
          items?: {
            properties?: Record<string, StringEnumProperty>;
          };
        };
      };
    };

    const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.agent-packet.schema.json"), "utf8")) as AgentPacketSchema;
    const allowedToolProperties = schema.properties?.allowedTools?.items?.properties ?? {};

    expect(allowedToolProperties.evidenceResourceId?.enum).toEqual(VISUAL_HIVE_EVIDENCE_RESOURCES.map((resource) => resource.id));
    expect(allowedToolProperties.evidenceResourceUri?.enum).toEqual(VISUAL_HIVE_EVIDENCE_RESOURCES.map((resource) => resource.uri));
    expect(allowedToolProperties.evidenceReadToolName?.enum).toEqual(
      VISUAL_HIVE_EVIDENCE_RESOURCES.flatMap((resource) => (resource.readTool ? [resource.readTool.name] : []))
    );
    expect(allowedToolProperties.artifactPath?.enum).toEqual(VISUAL_HIVE_EVIDENCE_RESOURCES.map((resource) => resource.relativePath));
  });
});

describe("tool registry", () => {
  it("builds conservative tool policy and role-scoped cards", async () => {
    const registry = buildToolRegistry({ project: "tool-fixture", now: new Date("2026-06-15T00:00:00.000Z") });
    const providerUpload = registry.tools.find((tool) => tool.id === "visual_hive_provider_upload");
    const providerDecisions = registry.tools.find((tool) => tool.id === "visual_hive_read_provider_decisions");
    const providerResults = registry.tools.find((tool) => tool.id === "visual_hive_read_provider_results");
    const providerUploadManifest = registry.tools.find((tool) => tool.id === "visual_hive_read_provider_upload_manifest");
    const providerHandoff = registry.tools.find((tool) => tool.id === "visual_hive_provider_handoff_dry_run");
    const visualHiveMcp = registry.tools.find((tool) => tool.id === "visual_hive_mcp");
    const controlPlaneSnapshot = registry.tools.find((tool) => tool.id === "visual_hive_read_control_plane_snapshot");
    const verdictTool = registry.tools.find((tool) => tool.id === "visual_hive_read_verdict");
    const hiveExportTool = registry.tools.find((tool) => tool.id === "visual_hive_read_hive_export");
    const githubIssue = registry.tools.find((tool) => tool.id === "visual_hive_handoff_github_issue");
    const handoffValidation = registry.tools.find((tool) => tool.id === "visual_hive_validate_handoff");
    const setupProfile = registry.roleProfiles.find((profile) => profile.role === "setup_agent");
    const repairProfile = registry.roleProfiles.find((profile) => profile.role === "repair_agent");
    const testCreatorProfile = registry.roleProfiles.find((profile) => profile.role === "test_creator");
    const reviewProfile = registry.roleProfiles.find((profile) => profile.role === "review_agent");
    const handoffProfile = registry.roleProfiles.find((profile) => profile.role === "handoff_agent");
    const providerProfile = registry.roleProfiles.find((profile) => profile.role === "provider_specialist");

    expect(registry.schemaVersion).toBe("visual-hive.tool-registry.v1");
    expect(registry.policy.exposeThirdPartyMcp).toBe(false);
    expect(registry.policy.externalUploadsFromPr).toBe(false);
    expect(registry.policy.maxExternalCostUsdPerTask).toBe(0);
    expect(registry.policy.requireHumanApprovalFor).toEqual(expect.arrayContaining(["provider_upload_enablement", "baseline_approval", "github_issue_creation"]));
    expect(providerUpload).toMatchObject({
      trustedOnly: true,
      externalNetwork: true,
      forbiddenInPullRequest: true,
      costClass: "paid_provider"
    });
    expect(providerUpload?.requiresHumanApproval).toEqual(expect.arrayContaining(["provider_upload_enablement", "external_network_access"]));
    expect(providerResults).toMatchObject({
      defaultAccess: "read_only",
      externalNetwork: false,
      trustedOnly: false,
      costClass: "local",
      writes: []
    });
    expect(providerDecisions).toMatchObject({
      defaultAccess: "read_only",
      externalNetwork: false,
      trustedOnly: false,
      costClass: "local",
      writes: []
    });
    expect(providerUploadManifest).toMatchObject({
      defaultAccess: "read_only",
      externalNetwork: false,
      trustedOnly: false,
      costClass: "local",
      writes: []
    });
    expect(providerHandoff).toMatchObject({
      defaultAccess: "read_only",
      externalNetwork: false,
      trustedOnly: false,
      costClass: "local",
      writes: [".visual-hive/provider-handoff.json"]
    });
    expect(visualHiveMcp).toMatchObject({
      enabled: true,
      kind: "first_party_mcp",
      defaultAccess: "read_only",
      externalNetwork: false,
      trustedOnly: false,
      forbiddenInPullRequest: false,
      mcp: {
        server: "visual-hive",
        transport: "stdio",
        status: "available"
      }
    });
    expect(controlPlaneSnapshot).toMatchObject({
      defaultAccess: "read_only",
      externalNetwork: false,
      trustedOnly: false,
      costClass: "local",
      writes: [".visual-hive/control-plane-snapshot.json"]
    });
    expect(controlPlaneSnapshot?.writeRestrictions).toContain("Read snapshot evidence only. Do not treat UI guidance as a verdict override.");
    expect(verdictTool).toMatchObject({
      defaultAccess: "read_only",
      externalNetwork: false,
      trustedOnly: false,
      costClass: "local",
      reads: [".visual-hive/verdict.json"],
      writes: []
    });
    expect(hiveExportTool).toMatchObject({
      defaultAccess: "read_only",
      externalNetwork: false,
      trustedOnly: false,
      costClass: "local",
      reads: [".visual-hive/hive/hive-export.json"],
      writes: []
    });
    expect(providerResults?.allowedRoles).toEqual(expect.arrayContaining(["review_agent", "handoff_agent", "provider_specialist"]));
    expect(providerUploadManifest?.allowedRoles).toEqual(expect.arrayContaining(["review_agent", "handoff_agent", "provider_specialist"]));
    expect(providerHandoff?.allowedRoles).toEqual(expect.arrayContaining(["review_agent", "handoff_agent", "provider_specialist"]));
    expect(githubIssue).toMatchObject({
      trustedOnly: true,
      externalNetwork: true,
      forbiddenInPullRequest: true
    });
    expect(handoffValidation).toMatchObject({
      defaultAccess: "read_only",
      externalNetwork: false,
      costClass: "local"
    });
    for (const resource of VISUAL_HIVE_EVIDENCE_RESOURCES.filter((item) => item.readTool)) {
      const tool = registry.tools.find((entry) => entry.id === resource.readTool?.name);
      expect(tool, `${resource.id} should have a Tool Registry read card`).toBeDefined();
      expect(tool?.label).toBe(resource.readTool?.title);
      expect(tool?.description).toBe(resource.readTool?.description);
      expect([...tool?.reads ?? [], ...tool?.writes ?? [], ...tool?.evidenceArtifacts ?? []]).toContain(resource.relativePath);
      expect(tool).toMatchObject({
        evidenceResourceId: resource.id,
        evidenceResourceUri: resource.uri,
        evidenceResourceTitle: resource.title,
        evidenceResourceDescription: resource.description,
        evidenceReadToolName: resource.readTool?.name
      });
      expect(tool?.externalNetwork).toBe(false);
    }
    for (const profile of registry.roleProfiles) {
      expect(profile.allowedToolIds.length).toBeLessThanOrEqual(registry.policy.maxToolDefinitionsPerAgent);
    }
    expect(setupProfile?.allowedToolIds).toEqual([
      "visual_hive_validate_config",
      "visual_hive_doctor",
      "visual_hive_recommend_setup",
      "visual_hive_read_setup_recommendations",
      "visual_hive_read_setup_pr_plan",
      "visual_hive_plan",
      "visual_hive_read_control_plane_snapshot",
      "visual_hive_agent_packet"
    ]);
    expect(repairProfile?.allowedToolIds).toEqual([
      "visual_hive_get_issue_context",
      "visual_hive_query_visual_graph",
      "visual_hive_get_visual_impact",
      "visual_hive_read_evidence_packet",
      "visual_hive_read_control_plane_snapshot",
      "visual_hive_read_verdict",
      "visual_hive_read_visual_graph",
      "visual_hive_read_visual_graph_impact"
    ]);
    expect(repairProfile?.allowedToolIds).not.toContain("visual_hive_provider_upload");
    expect(testCreatorProfile?.allowedToolIds).toEqual([
      "visual_hive_get_issue_context",
      "visual_hive_query_visual_graph",
      "visual_hive_get_visual_impact",
      "visual_hive_read_evidence_packet",
      "visual_hive_read_control_plane_snapshot",
      "visual_hive_read_verdict",
      "visual_hive_read_visual_graph",
      "visual_hive_read_visual_graph_impact"
    ]);
    expect(reviewProfile?.allowedToolIds).toEqual([
      "visual_hive_list_issues",
      "visual_hive_get_issue_context",
      "visual_hive_read_evidence_packet",
      "visual_hive_read_control_plane_snapshot",
      "visual_hive_read_verdict",
      "visual_hive_read_latest_report",
      "visual_hive_read_visual_graph",
      "visual_hive_read_visual_graph_impact"
    ]);
    expect(handoffProfile?.allowedToolIds).toEqual([
      "visual_hive_list_issues",
      "visual_hive_get_issue_context",
      "visual_hive_read_evidence_packet",
      "visual_hive_read_control_plane_snapshot",
      "visual_hive_read_verdict",
      "visual_hive_read_issue_queue",
      "visual_hive_query_visual_graph",
      "visual_hive_get_handoff_context"
    ]);
    expect(registry.tools.find((tool) => tool.id === "visual_hive_read_triage_report")).toMatchObject({
      evidenceResourceId: "triage-report",
      evidenceResourceUri: "visual-hive://triage-report",
      evidenceReadToolName: "visual_hive_read_triage_report",
      writes: []
    });
    expect(registry.tools.find((tool) => tool.id === "visual_hive_read_issue_body")).toMatchObject({
      evidenceResourceId: "issue-body",
      evidenceResourceUri: "visual-hive://issue-body",
      evidenceReadToolName: "visual_hive_read_issue_body",
      writes: []
    });
    expect(registry.tools.find((tool) => tool.id === "visual_hive_read_pr_comment")).toMatchObject({
      evidenceResourceId: "pr-comment",
      evidenceResourceUri: "visual-hive://pr-comment",
      evidenceReadToolName: "visual_hive_read_pr_comment",
      writes: []
    });
    expect(registry.tools.find((tool) => tool.id === "visual_hive_read_missing_tests")).toMatchObject({
      evidenceResourceId: "missing-tests",
      evidenceResourceUri: "visual-hive://missing-tests",
      evidenceReadToolName: "visual_hive_read_missing_tests",
      writes: []
    });
    expect(providerProfile?.trustedOnly).toBe(true);
    expect(providerProfile?.allowedToolIds).toEqual([
      "visual_hive_read_provider_decisions",
      "visual_hive_read_provider_results",
      "visual_hive_read_provider_upload_manifest",
      "visual_hive_read_provider_agent_packet",
      "visual_hive_provider_handoff_dry_run",
      "visual_hive_read_evidence_packet",
      "visual_hive_read_control_plane_snapshot",
      "visual_hive_read_verdict"
    ]);
    expect(providerProfile?.allowedToolIds).not.toContain("visual_hive_provider_upload");
  });

  it("keeps Tool Registry evidence-resource schema enums aligned with the core catalog", async () => {
    type StringEnumProperty = { enum?: string[] };
    type ToolRegistrySchema = {
      $defs?: {
        tool?: {
          properties?: Record<string, StringEnumProperty>;
        };
      };
    };

    const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.tool-registry.schema.json"), "utf8")) as ToolRegistrySchema;
    const toolProperties = schema.$defs?.tool?.properties ?? {};

    expect(toolProperties.evidenceResourceId?.enum).toEqual(VISUAL_HIVE_EVIDENCE_RESOURCES.map((resource) => resource.id));
    expect(toolProperties.evidenceResourceUri?.enum).toEqual(VISUAL_HIVE_EVIDENCE_RESOURCES.map((resource) => resource.uri));
    expect(toolProperties.evidenceReadToolName?.enum).toEqual(
      VISUAL_HIVE_EVIDENCE_RESOURCES.flatMap((resource) => (resource.readTool ? [resource.readTool.name] : []))
    );
  });

  it("writes registry and sanitized tool cards", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-tools-"));
    tempDirs.push(rootDir);
    const result = await writeToolRegistry({
      rootDir,
      project: "tool-fixture",
      now: new Date("2026-06-15T00:00:00.000Z")
    });

    expect(result.registryPath).toMatch(/tool-registry\.json$/);
    expect(result.cardsPath).toMatch(/tool-cards\.md$/);
    expect(result.cardsMarkdown).toContain("Tool: visual_hive_read_evidence_packet");
    expect(result.cardsMarkdown).toContain("Tool: visual_hive_read_control_plane_snapshot");
    expect(result.cardsMarkdown).toContain("Tool: visual_hive_read_verdict");
    expect(result.cardsMarkdown).toContain("Tool: visual_hive_validate_handoff");
    expect(result.cardsMarkdown).toContain("Tool: visual_hive_read_hive_export");
    expect(result.cardsMarkdown).toContain("Tool: visual_hive_read_hive_mode_comparison");
    expect(result.cardsMarkdown).toContain("Tool: visual_hive_read_provider_results");
    expect(result.cardsMarkdown).toContain("Tool: visual_hive_read_provider_upload_manifest");
    expect(result.cardsMarkdown).toContain("Tool: visual_hive_provider_handoff_dry_run");
    expect(result.cardsMarkdown).toContain("Third-party MCP exposed by default: false");
    expect(await readFile(result.registryPath, "utf8")).toContain("visual-hive.tool-registry.v1");
    expect(await readFile(result.cardsPath, "utf8")).toContain("Visual Hive Tool Cards");
  });
});

describe("context ledger", () => {
  it("derives budget usage, escalations, and redacted evidence from existing artifacts", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-context-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive", "tools"), { recursive: true });
    await mkdir(path.join(rootDir, ".visual-hive", "provider-upload", "argos"), { recursive: true });

    await writeToolRegistry({
      rootDir,
      project: "context-fixture",
      now: new Date("2026-06-15T00:00:00.000Z")
    });
    await writeJson(path.join(rootDir, ".visual-hive", "agent-packet.json"), {
      schemaVersion: "visual-hive.agent-packet.v1",
      project: "context-fixture",
      budgets: {
        maxToolCalls: 2,
        maxToolResultTokens: 500,
        maxExternalCostUsd: 0,
        allowExternalNetwork: false
      }
    });
    await writeJson(path.join(rootDir, ".visual-hive", "pipeline.json"), {
      schemaVersion: 1,
      project: "context-fixture",
      steps: [
        {
          id: "doctor",
          label: "Doctor",
          status: "passed",
          exitCode: 0,
          artifacts: [],
          message: "ok"
        },
        {
          id: "provider-upload",
          label: "Provider Upload",
          status: "failed",
          exitCode: 1,
          artifacts: [".visual-hive/provider-results.json"],
          message: "Authorization: Bearer provider-secret"
        },
        {
          id: "hive-trusted-repair-workflow-dry-run",
          label: "Hive Trusted Repair Workflow Dry Run",
          status: "passed",
          exitCode: 0,
          artifacts: [".visual-hive/hive/trusted-repair-workflow-dry-run.json", ".visual-hive/hive/trusted-repair-workflow-dry-run.md"],
          message: "No-network dry run"
        },
        {
          id: "triage",
          label: "Triage",
          status: "passed",
          exitCode: 0,
          artifacts: [
            ".visual-hive/triage.json",
            ".visual-hive/issue.md",
            ".visual-hive/pr-comment.md",
            ".visual-hive/triage-prompt.md",
            ".visual-hive/repair-prompt.md",
            ".visual-hive/missing-tests.md"
          ],
          message: "token=abc123"
        }
      ]
    });
    await writeJson(path.join(rootDir, ".visual-hive", "llm-usage.json"), {
      schemaVersion: 1,
      records: [
        {
          task: "repair_prompt",
          path: ".visual-hive/repair-prompt.md",
          promptOnly: true,
          callsMade: 0,
          estimatedTokens: 1200,
          estimatedCostUsd: 0,
          status: "disabled"
        }
      ]
    });
    await writeJson(path.join(rootDir, ".visual-hive", "provider-results.json"), {
      providers: [
        {
          result: {
            providerId: "argos",
            status: "missing_credentials",
            artifactCount: 4,
            missingEnv: ["ARGOS_TOKEN"],
            externalUploadBlockedReasons: ["client_secret=hidden"],
            normalized: { externalCallsMade: 0 },
            costPolicy: { estimatedExternalScreenshots: 4, blockedReasons: ["token=abc123"] }
          }
        }
      ]
    });
    await writeJson(path.join(rootDir, ".visual-hive", "provider-upload", "argos", "manifest.json"), {
      providerId: "argos",
      status: "dry_run",
      dryRun: true,
      externalCallsMade: 0,
      summary: {
        stagedArtifacts: 4,
        uploadedArtifacts: 0
      },
      command: "npm exec argos upload --token=hidden-token",
      stdout: "staged https://app.argos-ci.com/build?token=hidden-token",
      stderr: "authorization: Bearer hidden-token",
      providerUrl: "https://app.argos-ci.com/build?client_secret=hidden-token",
      blockedReasons: ["Cookie: session=secret"]
    });
    await writeJson(path.join(rootDir, ".visual-hive", "handoff.json"), {
      schemaVersion: "visual-hive.handoff.v1",
      status: "blocked",
      externalCallsMade: 0,
      blockedReasons: ["Hive token=abc123 missing review"]
    });
    await writeJson(path.join(rootDir, ".visual-hive", "hive-bead-request.json"), {
      schemaVersion: "visual-hive.hive-bead-request.v1",
      dryRun: true,
      externalCallsMade: 0,
      target: {
        tokenEnv: "HIVE_DASHBOARD_TOKEN",
        tokenPresent: false,
        missingTokenEnv: "HIVE_DASHBOARD_TOKEN"
      }
    });
    await writeJson(path.join(rootDir, ".visual-hive", "hive-handoff-result.json"), {
      schemaVersion: "visual-hive.hive-handoff-result.v1",
      status: "blocked",
      externalCallsMade: 0,
      blockedReasons: ["authorization: Bearer hive-secret"]
    });
    await writeJson(path.join(rootDir, ".visual-hive", "hive-handoff-validation.json"), {
      schemaVersion: "visual-hive.handoff-validation.v1",
      status: "blocked",
      summary: { externalCallsMade: 0 }
    });
    await writeJson(path.join(rootDir, ".visual-hive", "test-creation-plan.json"), {
      schemaVersion: "visual-hive.test-creation-plan.v1",
      recommendations: []
    });

    const ledger = await buildContextLedger({
      rootDir,
      project: "context-fixture",
      now: new Date("2026-06-15T00:00:00.000Z")
    });

    expect(ledger.schemaVersion).toBe("visual-hive.context-ledger.v1");
    expect(ledger.budgets.maxToolCalls).toBe(2);
    expect(ledger.usage.toolCallsUsed).toBe(4);
    expect(ledger.remaining.toolCalls).toBe(0);
    expect(ledger.usage.estimatedPromptTokens).toBe(1200);
    expect(ledger.usage.providerScreenshots).toBe(4);
    expect(ledger.sourceArtifacts.pipeline).toBe(".visual-hive/pipeline.json");
    expect(ledger.sourceArtifacts.handoffPacket).toBe(".visual-hive/handoff.json");
    expect(ledger.sourceArtifacts.hiveBeadRequest).toBe(".visual-hive/hive-bead-request.json");
    expect(ledger.sourceArtifacts.hiveHandoffResult).toBe(".visual-hive/hive-handoff-result.json");
    expect(ledger.sourceArtifacts.hiveHandoffValidation).toBe(".visual-hive/hive-handoff-validation.json");
    expect(ledger.sourceArtifacts.testCreationPlan).toBe(".visual-hive/test-creation-plan.json");
    expect(ledger.toolCalls.find((call) => call.toolId === "visual_hive_provider_upload")).toMatchObject({
      evidenceResourceId: "provider-results",
      evidenceResourceUri: "visual-hive://provider-results",
      evidenceResourceTitle: "Provider Results",
      evidenceReadToolName: "visual_hive_read_provider_results"
    });
    expect(ledger.toolCalls.find((call) => call.id === "hive-trusted-repair-workflow-dry-run")).toMatchObject({
      evidenceResourceId: "hive-trusted-repair-workflow-dry-run",
      evidenceResourceUri: "visual-hive://hive-trusted-repair-workflow-dry-run",
      evidenceResourceTitle: "Hive Trusted Repair Workflow Dry Run",
      evidenceReadToolName: "visual_hive_read_hive_trusted_repair_workflow_dry_run"
    });
    const triageCall = ledger.toolCalls.find((call) => call.id === "triage");
    expect(triageCall).toMatchObject({
      evidenceResourceId: "triage-report",
      evidenceResourceUri: "visual-hive://triage-report",
      evidenceResourceTitle: "Triage Report",
      evidenceReadToolName: "visual_hive_read_triage_report"
    });
    expect(triageCall?.evidenceResources?.map((resource) => resource.evidenceResourceId)).toEqual([
      "triage-report",
      "issue-body",
      "pr-comment",
      "triage-prompt",
      "repair-prompt",
      "missing-tests"
    ]);
    expect(triageCall?.evidenceResources?.find((resource) => resource.evidenceResourceId === "missing-tests")).toMatchObject({
      evidenceResourceUri: "visual-hive://missing-tests",
      evidenceReadToolName: "visual_hive_read_missing_tests",
      artifactPath: ".visual-hive/missing-tests.md"
    });
    expect(ledger.providerUsage[0]).toMatchObject({
      providerId: "argos",
      uploadStatus: "dry_run",
      artifactCount: 4,
      stagedArtifacts: 4,
      uploadedArtifacts: 0,
      estimatedExternalScreenshots: 4,
      externalCallsMade: 0,
      manifestPath: ".visual-hive/provider-upload/argos/manifest.json",
      uploadDirectory: ".visual-hive/provider-upload/argos",
      dryRun: true
    });
    expect(ledger.providerUsage[0]?.command).toContain("[REDACTED]");
    expect(ledger.providerUsage[0]?.stdout).toContain("[REDACTED]");
    expect(ledger.providerUsage[0]?.stderr).toContain("[REDACTED]");
    expect(ledger.providerUsage[0]?.providerUrl).toContain("[REDACTED]");
    expect(ledger.providerUsage[0]?.missingEnv).toEqual(["ARGOS_TOKEN"]);
    expect(ledger.policyViolations.map((violation) => violation.policy)).toEqual(expect.arrayContaining(["maxToolCalls", "maxProviderScreenshots"]));
    expect(ledger.escalations.map((escalation) => escalation.kind)).toContain("provider");
    expect(ledger.escalations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "trusted_tool",
          severity: "blocked",
          relatedToolIds: ["visual_hive_handoff"]
        })
      ])
    );
    const serialized = JSON.stringify(ledger);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("hive-secret");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("session=secret");
    expect(serialized).not.toContain("hidden-token");
  });

  it("allows explicit Context Ledger budget overrides for bounded acceptance pipelines", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-context-budget-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "pipeline.json"), {
      schemaVersion: 1,
      steps: Array.from({ length: 37 }, (_, index) => ({
        id: `step-${index + 1}`,
        label: `Step ${index + 1}`,
        status: "passed",
        exitCode: 0,
        artifacts: []
      }))
    });

    const strictLedger = await buildContextLedger({
      rootDir,
      project: "context-budget",
      now: new Date("2026-06-15T00:00:00.000Z")
    });
    const acceptanceLedger = await buildContextLedger({
      rootDir,
      project: "context-budget",
      now: new Date("2026-06-15T00:00:00.000Z"),
      budgets: { maxToolCalls: 40 }
    });

    expect(strictLedger.usage.toolCallsUsed).toBe(37);
    expect(strictLedger.policyViolations.map((violation) => violation.policy)).toContain("maxToolCalls");
    expect(acceptanceLedger.budgets.maxToolCalls).toBe(40);
    expect(acceptanceLedger.remaining.toolCalls).toBe(3);
    expect(acceptanceLedger.policyViolations.map((violation) => violation.policy)).not.toContain("maxToolCalls");
  });

  it("writes context-ledger.json as a schema-versioned artifact", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-context-write-"));
    tempDirs.push(rootDir);

    const result = await writeContextLedger({
      rootDir,
      project: "context-write",
      now: new Date("2026-06-15T00:00:00.000Z")
    });

    expect(result.ledgerPath).toBe(path.join(rootDir, ".visual-hive", "context-ledger.json"));
    expect(result.ledger.schemaVersion).toBe("visual-hive.context-ledger.v1");
    expect(await readFile(result.ledgerPath, "utf8")).toContain("visual-hive.context-ledger.v1");
  });

  it("keeps Context Ledger tool-call evidence-resource schema enums aligned with the core catalog", async () => {
    type StringEnumProperty = { enum?: string[] };
    type ContextLedgerSchema = {
      $defs?: {
        toolCall?: {
          properties?: Record<string, StringEnumProperty>;
        };
      };
    };

    const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.context-ledger.schema.json"), "utf8")) as ContextLedgerSchema;
    const toolCallProperties = schema.$defs?.toolCall?.properties ?? {};

    expect(toolCallProperties.evidenceResourceId?.enum).toEqual(VISUAL_HIVE_EVIDENCE_RESOURCES.map((resource) => resource.id));
    expect(toolCallProperties.evidenceResourceUri?.enum).toEqual(VISUAL_HIVE_EVIDENCE_RESOURCES.map((resource) => resource.uri));
    expect(toolCallProperties.evidenceReadToolName?.enum).toEqual(
      VISUAL_HIVE_EVIDENCE_RESOURCES.flatMap((resource) => (resource.readTool ? [resource.readTool.name] : []))
    );
  });
});

describe("agent-forward schema validation", () => {
  it("validates generated evidence, verdict, handoff, agent, tool, and context artifacts against checked-in schemas", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-schema-validation-"));
    tempDirs.push(rootDir);
    const report = reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png");
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);
    await writeJson(path.join(rootDir, ".visual-hive", "mutation-report.json"), {
      schemaVersion: 2,
      project: "schema-fixture",
      generatedAt: "2026-06-15T00:01:00.000Z",
      minScore: 0.75,
      score: 1,
      killed: 1,
      total: 1,
      results: [
        {
          operator: "force-login-on-demo",
          status: "killed",
          killed: true,
          contractIds: ["dashboard"],
          applicable: true,
          expectedFailureKinds: ["unexpected_element"],
          durationMs: 10,
          errors: [],
          artifacts: [".visual-hive/mutation-report.json"]
        }
      ]
    });

    const evidence = await writeEvidencePacket({
      rootDir,
      project: "schema-fixture",
      now: new Date("2026-06-15T00:02:00.000Z")
    });
    const verdict = await writeVerdictReport({
      rootDir,
      project: "schema-fixture",
      now: new Date("2026-06-15T00:03:00.000Z")
    });
    const handoff = await writeHandoffArtifacts({
      rootDir,
      evidencePacket: evidence.packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      now: new Date("2026-06-15T00:04:00.000Z")
    });
    const handoffValidation = await validateHandoffArtifacts({
      rootDir,
      now: new Date("2026-06-15T00:04:30.000Z")
    });
    const agent = await writeAgentPacket({
      rootDir,
      evidencePacket: evidence.packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      handoffPacket: handoff.handoff,
      handoffPacketPath: ".visual-hive/handoff.json",
      profile: "repair_agent",
      now: new Date("2026-06-15T00:05:00.000Z")
    });
    const tools = await writeToolRegistry({
      rootDir,
      project: "schema-fixture",
      now: new Date("2026-06-15T00:06:00.000Z")
    });
    const context = await writeContextLedger({
      rootDir,
      project: "schema-fixture",
      now: new Date("2026-06-15T00:07:00.000Z")
    });

    await expectMatchesSchema("visual-hive.evidence-packet.schema.json", evidence.packet);
    await expectMatchesSchema("visual-hive.verdict.schema.json", verdict.report);
    await expectMatchesSchema("visual-hive.handoff.schema.json", handoff.handoff);
    await expectMatchesSchema("visual-hive.hive-bead-request.schema.json", handoff.beadRequest);
    await expectMatchesSchema("visual-hive.hive-handoff-result.schema.json", handoff.result);
    await expectMatchesSchema("visual-hive.handoff-validation.schema.json", handoffValidation.report);
    await expectMatchesSchema("visual-hive.agent-packet.schema.json", agent.packet);
    await expectMatchesSchema("visual-hive.tool-registry.schema.json", tools.registry);
    await expectMatchesSchema("visual-hive.context-ledger.schema.json", context.ledger);
    expect(evidence.packet.schemaVersion).toBe("visual-hive.evidence-packet.v2");
    expect(evidence.packet.evidenceContributions.every((contribution) => contribution.key && contribution.authority)).toBe(true);
  }, 15_000);
});

async function writeMinimalConfig(repoRoot: string, projectName: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, "visual-hive.config.yaml"),
    `project:
  name: ${projectName}
targets:
  local:
    kind: url
    url: "http://127.0.0.1:4173"
contracts:
  - id: dashboard
    description: Dashboard
    target: local
`,
    "utf8"
  );
}

function connectionReport(project: string, status: "passed" | "failed", generatedAt = "2026-06-15T00:00:00.000Z"): Report {
  return {
    schemaVersion: 2,
    project,
    repository: sampleRepository,
    mode: "pr",
    generatedAt,
    status,
    changedFiles: [],
    selectedTargets: [],
    selectedContracts: [],
    excludedContracts: [],
    targetLifecycle: [],
    generatedSpecPath: ".visual-hive/generated/visual-hive.generated.spec.ts",
    results: [],
    summary: {
      passed: status === "passed" ? 1 : 0,
      failed: status === "failed" ? 1 : 0,
      screenshotsPassed: 0,
      screenshotsFailed: 0,
      baselinesCreated: 0,
      createdBaselines: 0,
      missingBaselines: 0,
      visualDiffs: 0,
      consoleErrors: 0,
      pageErrors: 0
    },
    consoleErrors: [],
    pageErrors: [],
    artifacts: [],
    reproductionCommands: []
  };
}

function connectionCoverage(
  project: string,
  gaps: Array<{ kind: string; severity: "low" | "medium" | "high"; message: string; targetId?: string; contractId?: string; route?: string; viewport?: string }>
): unknown {
  return {
    schemaVersion: 1,
    project,
    generatedAt: "2026-06-15T00:05:00.000Z",
    mode: "pr",
    summary: {
      targetCount: 2,
      contractCount: 2,
      selectedContracts: 1,
      unselectedContracts: 1,
      prSafeContracts: 1,
      protectedContracts: 0,
      scheduleOnlyContracts: 0,
      routesCovered: 1,
      viewportsCovered: 1,
      uncoveredTargets: gaps.some((gap) => gap.kind === "target_without_contracts") ? 1 : 0,
      uncoveredContracts: gaps.some((gap) => gap.kind === "contract_without_assertions") ? 1 : 0,
      changedFileRules: 1,
      matchedChangedFileRules: 1,
      unmatchedChangedFiles: 0
    },
    targets: [],
    contracts: [],
    routes: [],
    viewports: [],
    changedFileCoverage: [],
    unmatchedChangedFiles: [],
    uncoveredAreas: gaps
  };
}

function reportFixture(repoRoot: string, actualPath: string, baselinePath: string): Report {
  return {
    schemaVersion: 2,
    project: "baseline-fixture",
    repository: sampleRepository,
    mode: "manual",
    generatedAt: "2026-06-15T00:00:00.000Z",
    status: "failed",
    changedFiles: [],
    selectedTargets: [{ id: "local", kind: "url", url: "http://127.0.0.1:4173", prSafe: true, cost: "cheap" }],
    selectedContracts: ["dashboard"],
    excludedContracts: [],
    targetLifecycle: [],
    generatedSpecPath: path.join(repoRoot, ".visual-hive", "generated", "visual-hive.generated.spec.ts"),
    results: [
      {
        contractId: "dashboard",
        targetId: "local",
        status: "failed",
        durationMs: 1,
        errors: ["visual diff"],
        artifacts: [actualPath],
        screenshotAssertions: [
          {
            contractId: "dashboard",
            screenshotName: "desktop",
            name: "desktop",
            route: "/",
            viewport: "desktop",
            status: "failed",
            baselinePath,
            actualPath,
            maxDiffPixelRatio: 0.01,
            actualDiffPixelRatio: 0.2,
            actualDiffPixels: 20,
            diffPixels: 20,
            totalPixels: 100
          }
        ],
        consoleErrors: [],
        pageErrors: [],
        networkErrors: [],
        reproductionCommand: "visual-hive run --ci"
      }
    ],
    summary: {
      passed: 0,
      failed: 1,
      screenshotsPassed: 0,
      screenshotsFailed: 1,
      baselinesCreated: 0,
      createdBaselines: 0,
      missingBaselines: 0,
      visualDiffs: 1,
      consoleErrors: 0,
      pageErrors: 0
    },
    consoleErrors: [],
    pageErrors: [],
    artifacts: [actualPath],
    reproductionCommands: ["visual-hive run --ci"]
  };
}

function passedReportFixture(repoRoot: string, actualPath: string, baselinePath: string): Report {
  const report = reportFixture(repoRoot, actualPath, baselinePath);
  report.status = "passed";
  report.results[0]!.status = "passed";
  report.results[0]!.errors = [];
  report.results[0]!.screenshotAssertions![0]!.status = "passed";
  report.results[0]!.screenshotAssertions![0]!.actualDiffPixelRatio = 0;
  report.results[0]!.screenshotAssertions![0]!.actualDiffPixels = 0;
  report.results[0]!.screenshotAssertions![0]!.diffPixels = 0;
  report.summary = {
    passed: 1,
    failed: 0,
    screenshotsPassed: 1,
    screenshotsFailed: 0,
    baselinesCreated: 0,
    createdBaselines: 0,
    missingBaselines: 0,
    visualDiffs: 0,
    consoleErrors: 0,
    pageErrors: 0
  };
  return report;
}

async function providerUploadFixture(): Promise<{ rootDir: string; report: Report }> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-provider-upload-"));
  tempDirs.push(rootDir);
  const actualPath = path.join(".visual-hive", "artifacts", "screenshots", "dashboard.png");
  const baselinePath = path.join(".visual-hive", "snapshots", "dashboard.png");
  await mkdir(path.dirname(path.join(rootDir, actualPath)), { recursive: true });
  await writeFile(path.join(rootDir, actualPath), Buffer.from("fake-png-bytes"));
  await writeJson(path.join(rootDir, ".visual-hive", "report.json"), { sample: true, token: "secret-token-value" });
  return { rootDir, report: reportFixture(rootDir, actualPath, baselinePath) };
}

function argosEnabledConfig(upload: Partial<VisualHiveConfig["providers"]["argos"]["upload"]> = {}): VisualHiveConfig {
  return VisualHiveConfigSchema.parse({
    ...sampleConfig(),
    providers: {
      argos: {
        enabled: true,
        projectId: "visual-hive/demo",
        upload
      }
    },
    costPolicy: {
      maxExternalScreenshotsPerRun: 10,
      maxMonthlyExternalScreenshots: 1000,
      externalUpload: {
        pullRequest: false,
        schedule: true,
        manual: true,
        canary: false,
        mutation: false,
        full: true,
        onFailureOnly: false,
        criticalContractsOnly: false
      }
    }
  });
}

describe("issue artifacts", () => {
  it("sanitizes issue artifact paths to repo-relative or redacted external paths", () => {
    const rootDir = "C:/Users/david/OneDrive/Documents/visual-hive-demo-site";
    expect(sanitizeArtifactPathForIssue(rootDir, "C:\\Users\\david\\OneDrive\\Documents\\visual-hive-demo-site\\.visual-hive\\artifacts\\screenshots\\home.png")).toBe(".visual-hive/artifacts/screenshots/home.png");
    expect(sanitizeArtifactPathForIssue(rootDir, "C:/Users/david/secret/path/token.png")).toBe("[redacted-external-path]/token.png");
    expect(sanitizeArtifactPathForIssue("/home/david/work/repo", "/home/david/work/repo/.visual-hive/report.json")).toBe(".visual-hive/report.json");
    expect(sanitizeArtifactPathForIssue("/home/david/work/repo", "/home/david/.ssh/id_rsa")).toBe("[redacted-external-path]/id_rsa");
    expect(sanitizeArtifactPathsForMarkdown("/tmp/visual-hive-ci-repo", "See /tmp/visual-hive-ci-repo/.visual-hive/report.json and /tmp/visual-hive-ci-repo/src/App.tsx")).toBe(
      "See .visual-hive/report.json and src/App.tsx"
    );
    const markdown = sanitizeArtifactPathsForMarkdown(rootDir, "See C:/Users/david/OneDrive/Documents/visual-hive-demo-site/.visual-hive/report.json and /home/david/private/file.txt");
    expect(markdown).toContain(".visual-hive/report.json");
    expect(markdown).toContain("[redacted-external-path]/file.txt");
    expect(sanitizeArtifactPathsForMarkdown(rootDir, 'url: "http://127.0.0.1:4173"')).toContain("http://127.0.0.1:4173");
    expect(markdown).not.toContain("C:/Users/david");
    expect(markdown).not.toContain("/home/david/private");
  });

  it("sanitizes Hive handoff issue bodies generated from absolute report artifact paths", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-handoff-issue-paths-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    const absoluteActualPath = path.join(rootDir, ".visual-hive", "artifacts", "screenshots", "dashboard.png");
    const absoluteBaselinePath = path.join(rootDir, ".visual-hive", "snapshots", "dashboard.png");
    const report = reportFixture(rootDir, absoluteActualPath, absoluteBaselinePath);
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), report);
    const evidence = await writeEvidencePacket({
      rootDir,
      project: "issue-paths",
      now: new Date("2026-06-15T00:01:00.000Z")
    });
    const handoff = buildHandoffArtifacts({
      rootDir,
      evidencePacket: evidence.packet,
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      now: new Date("2026-06-15T00:02:00.000Z")
    });

    expect(handoff.issueBody).toContain("baseline=.visual-hive/snapshots/dashboard.png");
    expect(handoff.issueBody).toContain("actual=.visual-hive/artifacts/screenshots/dashboard.png");
    expect(handoff.issueBody).toContain("- Generated spec: .visual-hive/generated/visual-hive.generated.spec.ts");
    expect(handoff.issueBody).not.toContain(rootDir.replaceAll("\\", "/"));
    expect(handoff.issueBody).not.toMatch(/C:[\\/](?:Users|Documents)/i);
    expect(handoff.issueBody).not.toContain("OneDrive");
    expect(handoff.issueBody).not.toMatch(/\/(?:Users|home)\//);
  });

  it("builds deduplicated issue candidates from report and mutation evidence", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-issues-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"));
    await writeJson(path.join(rootDir, ".visual-hive", "mutation-report.json"), {
      schemaVersion: 2,
      project: "issues-demo",
      generatedAt: "2026-01-01T00:00:00.000Z",
      minScore: 0.8,
      score: 0,
      killed: 0,
      total: 1,
      results: [
        {
          operator: "force-login-on-demo",
          status: "survived",
          killed: false,
          contractIds: ["hosted-demo-never-login"],
          applicable: true,
          affectedSurfaces: [{ contractId: "hosted-demo-never-login", route: "/" }],
          expectedFailureKinds: ["login_regression"],
          failedAssertion: "Login controls were not detected by the contract.",
          durationMs: 10,
          errors: [],
          artifacts: [".visual-hive/mutation-report.json"],
          validationCommand: "visual-hive mutate",
          mutationMode: "runtime",
          sourceMutation: false
        }
      ]
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "issues-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "issues-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "visual-graph.json"), { schemaVersion: "visual-hive.visual-graph.v1", project: "issues-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "visual-impact.json"), { schemaVersion: "visual-hive.visual-impact.v1", project: "issues-demo" });

    const result = await writeIssuesArtifacts({ rootDir, project: "issues-demo" });

    expect(result.report.externalCallsMade).toBe(0);
    expect(result.report.networkCallsMade).toBe(0);
    expect(result.report.issues.map((issue) => issue.issueKind)).toContain("mutation_survivor");
    expect(result.report.issues.every((issue) => issue.dedupeFingerprint.startsWith("visual-hive:"))).toBe(true);
    const survivor = result.report.issues.find((issue) => issue.issueKind === "mutation_survivor");
    expect(survivor?.linkedEvidencePacket).toBe(".visual-hive/evidence-packet.json");
    expect(survivor?.linkedRepoMap).toBe(".visual-hive/repo-map.json");
    expect(survivor?.linkedVisualGraph).toBe(".visual-hive/visual-graph.json");
    expect(survivor?.linkedVisualImpact).toBe(".visual-hive/visual-impact.json");
    expect(survivor?.body).toContain(".visual-hive/visual-graph.json");
    expect(survivor?.body).toContain(".visual-hive/visual-impact.json");
    expect(survivor?.body).toContain("Visual Hive does not repair code");
    expect(result.queue.summary.readyForHive).toBeGreaterThan(0);
    expect(result.setupIssue.body).toContain("[Visual Hive] Setup visual QA");
  });

  it("promotes a repository unit-test recommendation into a stable Hive issue", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-test-adequacy-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "test-creation-plan.json"), {
      schemaVersion: "visual-hive.test-creation-plan.v1",
      recommendations: [
        {
          id: "layer-2-unknown",
          gapId: "testing-layer:2:unknown",
          source: "testing_layer",
          kind: "unit_test",
          priority: "medium",
          title: "Add unit test evidence for Unit",
          rationale: ["No repository unit test runner or test file was detected."],
          suggestedTests: ["Add focused tests for non-visual behavior."],
          artifacts: [".visual-hive/repo-map.json"],
          affected: { route: "/", component: "critical-route-shell" },
          trustedOnly: false,
          applyMode: "advisory_no_write"
        }
      ]
    });

    const first = await writeIssuesArtifacts({ rootDir, project: "test-adequacy-demo" });
    const result = await writeIssuesArtifacts({ rootDir, project: "test-adequacy-demo" });
    const issue = result.report.issues.find((candidate) => candidate.issueKind === "test_adequacy_gap");

    expect(issue).toMatchObject({ severity: "high", owningAgentHint: "visual-hive/test-creator" });
    expect(issue?.status).toBe("update_candidate");
    expect(issue?.dedupeFingerprint).toBe(first.report.issues.find((candidate) => candidate.issueKind === "test_adequacy_gap")?.dedupeFingerprint);
    expect(issue?.dedupeFingerprint).toBe("visual-hive:test-adequacy-demo:test_adequacy_gap:unknown:85ead75abf845bfe");
    expect(issue?.affected).toContainEqual({ contractId: "testing-layer:2" });
    expect(issue?.sourceArtifacts).toContain(".visual-hive/test-creation-plan.json");
    expect(issue?.validationCommand).toContain("node --test");
    expect(issue?.body).toContain("add focused repository test files only");
    await expectMatchesSchema("visual-hive.issues.schema.json", result.report);
  });

  it("normalizes Node built-in test files as covered unit evidence", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-node-test-layer-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, "tests"), { recursive: true });
    await writeFile(path.join(rootDir, "package.json"), JSON.stringify({ name: "node-test-layer", type: "module" }), "utf8");
    await writeFile(path.join(rootDir, "tests", "safe-default.test.js"), `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("safe default", () => assert.equal(1, 1));\n`, "utf8");
    const repo = await writeRepoMap({ repoRoot: rootDir, now: new Date("2026-06-15T00:00:00.000Z") });
    const evidence = await buildEvidencePacket({ rootDir, project: "node-test-layer", now: new Date("2026-06-15T00:01:00.000Z") });

    expect(repo.report.testTools).toContain("node-test");
    expect(evidence.testingLayers.find((layer) => layer.id === 2)).toMatchObject({ status: "covered", gaps: [] });
  });

  it("preserves affected contracts on handoff repair issues", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-handoff-contracts-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "handoff.json"), {
      workItems: [
        {
          id: "playwright.console_error.deploy-preview-smoke",
          kind: "repair",
          priority: "high",
          title: "Repair deploy-preview-smoke: console_error",
          summary: "Hosted asset returned 404.",
          artifacts: [".visual-hive/artifacts/results/deploy-preview-smoke.json"]
        }
      ]
    });

    const result = await buildIssuesReport({ rootDir, project: "handoff-contracts" });
    const issue = result.report.issues.find((candidate) => candidate.title.includes("console_error"));

    expect(issue?.affected).toEqual([{ contractId: "deploy-preview-smoke" }]);
    expect(issue?.body).toContain("contractId=deploy-preview-smoke");
  });

  it("removes local absolute artifact paths from issue and publish markdown", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-issues-paths-"));
    tempDirs.push(rootDir);
    const insideActual = path.join(rootDir, ".visual-hive", "artifacts", "screenshots", "dashboard.png");
    const insideBaseline = path.join(rootDir, ".visual-hive", "snapshots", "dashboard.png");
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), reportFixture(rootDir, insideActual, insideBaseline));
    await writeJson(path.join(rootDir, ".visual-hive", "mutation-report.json"), {
      schemaVersion: 2,
      project: "issue-paths-demo",
      generatedAt: "2026-01-01T00:00:00.000Z",
      minScore: 0.8,
      score: 0,
      killed: 0,
      total: 1,
      results: [
        {
          operator: "force-login-on-demo",
          status: "survived",
          killed: false,
          contractIds: ["hosted-demo-never-login"],
          applicable: true,
          affectedSurfaces: [{ contractId: "hosted-demo-never-login", route: "/" }],
          expectedFailureKinds: ["login_regression"],
          durationMs: 10,
          errors: [],
          artifacts: [insideActual],
          validationCommand: "visual-hive mutate",
          mutationMode: "runtime",
          sourceMutation: false
        }
      ]
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "issue-paths-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "issue-paths-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "visual-graph.json"), { schemaVersion: "visual-hive.visual-graph.v1" });
    await writeJson(path.join(rootDir, ".visual-hive", "visual-impact.json"), { schemaVersion: "visual-hive.visual-impact.v1" });
    const issues = await writeIssuesArtifacts({ rootDir, project: "issue-paths-demo" });
    const issue = issues.report.issues.find((candidate) => candidate.issueKind === "mutation_survivor")!;

    expect(issue.sourceArtifacts.join("\n")).toContain(".visual-hive/artifacts/screenshots/dashboard.png");
    expect(issue.body).toContain(".visual-hive/artifacts/screenshots/dashboard.png");
    expect(issue.body).not.toContain(rootDir.replaceAll("\\", "/"));
    expect(issues.markdown).not.toContain(rootDir.replaceAll("\\", "/"));

    const publish = await writeIssuePublishArtifacts({ rootDir });
    const serialized = JSON.stringify(publish);
    expect(serialized).toContain(".visual-hive/artifacts/screenshots/dashboard.png");
    expect(serialized).not.toContain(rootDir.replaceAll("\\", "/"));
    await expectMatchesSchema("visual-hive.issue-publish-plan.schema.json", publish.plan);
  });

  it("plans write-preview branches without creating branches by default", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-write-preview-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"));
    await writeJson(path.join(rootDir, ".visual-hive", "mutation-report.json"), {
      schemaVersion: 2,
      project: "write-preview-demo",
      generatedAt: "2026-01-01T00:00:00.000Z",
      minScore: 0.8,
      score: 0,
      killed: 0,
      total: 1,
      results: [
        {
          operator: "force-login-on-demo",
          status: "survived",
          killed: false,
          contractIds: ["hosted-demo-never-login"],
          applicable: true,
          affectedSurfaces: [{ contractId: "hosted-demo-never-login", route: "/" }],
          expectedFailureKinds: ["login_regression"],
          durationMs: 10,
          errors: [],
          artifacts: [".visual-hive/mutation-report.json"],
          validationCommand: "visual-hive mutate",
          mutationMode: "runtime",
          sourceMutation: false
        }
      ]
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "write-preview-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "write-preview-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "visual-graph.json"), { schemaVersion: "visual-hive.visual-graph.v1" });
    await writeJson(path.join(rootDir, ".visual-hive", "visual-impact.json"), { schemaVersion: "visual-hive.visual-impact.v1" });
    await writeIssuesArtifacts({ rootDir, project: "write-preview-demo" });

    const gitCalls: string[][] = [];
    const result = await writeAgentWritePreview({
      rootDir,
      project: "write-preview-demo",
      gitRunner: async (args) => {
        gitCalls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      }
    });

    expect(result.preview.mode).toBe("dry_run");
    expect(result.preview.status).toBe("planned");
    expect(result.preview.branchName).toMatch(/^visual-hive\/issue-visual-hive-/);
    expect(result.preview.safety.branchesCreated).toBe(0);
    expect(result.preview.safety.pullRequestsOpened).toBe(0);
    expect(result.preview.safety.pushesPerformed).toBe(0);
    expect(gitCalls).toHaveLength(0);
  });

  it("requires explicit write-preview flags and a clean tree before creating a local branch", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-write-preview-branch-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"));
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "write-preview-branch-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "write-preview-branch-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "visual-graph.json"), { schemaVersion: "visual-hive.visual-graph.v1" });
    await writeJson(path.join(rootDir, ".visual-hive", "visual-impact.json"), { schemaVersion: "visual-hive.visual-impact.v1" });
    await writeIssuesArtifacts({ rootDir, project: "write-preview-branch-demo" });

    const dirty = await writeAgentWritePreview({
      rootDir,
      project: "write-preview-branch-demo",
      allowWrite: true,
      writePreviewBranch: true,
      gitRunner: async (args) => {
        if (args[0] === "status") return { status: 0, stdout: " M src/App.tsx\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      }
    });
    expect(dirty.preview.status).toBe("blocked");
    expect(dirty.preview.safety.branchesCreated).toBe(0);
    expect(dirty.preview.blockedReasons.join("\n")).toContain("working tree is dirty");

    const gitCalls: string[][] = [];
    const clean = await writeAgentWritePreview({
      rootDir,
      project: "write-preview-branch-demo",
      allowWrite: true,
      writePreviewBranch: true,
      gitRunner: async (args) => {
        gitCalls.push(args);
        if (args[0] === "status") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "switch") return { status: 0, stdout: "Switched to a new branch", stderr: "" };
        return { status: 1, stdout: "", stderr: "unexpected command" };
      }
    });

    expect(clean.preview.mode).toBe("write_preview");
    expect(clean.preview.status).toBe("created");
    expect(clean.preview.safety.branchesCreated).toBe(1);
    expect(clean.preview.safety.commitsCreated).toBe(0);
    expect(clean.preview.safety.pullRequestsOpened).toBe(0);
    expect(clean.preview.safety.pushesPerformed).toBe(0);
    expect(gitCalls.some((args) => args.join(" ") === "status --short")).toBe(true);
    expect(gitCalls.some((args) => args[0] === "switch" && args[1] === "-c" && args[2] === clean.preview.branchName)).toBe(true);
  });

  it("refreshes the Visual Graph with issue candidate nodes when issue artifacts are written", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-issues-graph-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(path.join(rootDir, "package.json"), JSON.stringify({ name: "issues-graph-demo", scripts: { preview: "vite preview" } }), "utf8");
    await writeFile(
      path.join(rootDir, "visual-hive.config.yaml"),
      `project:
  name: issues-graph-demo
  type: react-vite
targets:
  localPreview:
    kind: url
    url: http://127.0.0.1:4173
    prSafe: true
contracts:
  - id: hosted-demo-never-login
    description: Public demo never exposes login
    target: localPreview
    runOn:
      pullRequest: true
    selectors:
      mustExist:
        - "[data-testid='dashboard-page']"
      mustNotExist:
        - "[data-testid='login-page']"
    screenshots:
      - name: dashboard
        route: /
        viewport: desktop
viewports:
  desktop:
    width: 1440
    height: 900
`,
      "utf8"
    );
    await writeFile(path.join(rootDir, "src", "App.tsx"), `export function App() { return <main data-testid="dashboard-page" />; }\n`, "utf8");
    await writeRepoMap({ repoRoot: rootDir, now: new Date("2026-06-15T00:00:00.000Z") });
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"));

    await writeIssuesArtifacts({ rootDir, project: "issues-graph-demo" });

    const graph = await readVisualGraph(rootDir);
    expect(graph.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "issue_candidate" })]));
    expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ relation: "backs_issue" })]));
  });

  it("marks disappeared findings as resolved candidates and honors suppressions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-issues-lifecycle-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"));
    const first = await writeIssuesArtifacts({ rootDir, project: "lifecycle-demo" });
    const firstIssue = first.report.issues[0]!;
    await writeJson(path.join(rootDir, ".visual-hive", "issue-suppressions.json"), {
      suppressions: [{ dedupeFingerprint: firstIssue.dedupeFingerprint, reason: "Covered by manual release checklist", expiresAt: "2999-01-01T00:00:00.000Z" }]
    });

    const suppressed = await buildIssuesReport({ rootDir, project: "lifecycle-demo" });
    expect(suppressed.report.issues.find((issue) => issue.dedupeFingerprint === firstIssue.dedupeFingerprint)?.status).toBe("suppressed");

    await writeJson(path.join(rootDir, ".visual-hive", "issues.json"), first.report);
    await writeJson(path.join(rootDir, ".visual-hive", "issue-suppressions.json"), { suppressions: [] });
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), passedReportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"));
    const resolved = await buildIssuesReport({ rootDir, project: "lifecycle-demo" });
    const resolvedIssue = resolved.report.issues.find((issue) => issue.dedupeFingerprint === firstIssue.dedupeFingerprint);

    expect(resolvedIssue?.status).toBe("resolved_candidate");
    expect(resolvedIssue?.labels).toContain("visual-hive/resolved-candidate");
    expect(resolvedIssue?.body).toContain("Resolved Candidate Evidence");

    await writeJson(path.join(rootDir, ".visual-hive", "issues.json"), resolved.report);
    const publish = await writeIssuePublishArtifacts({
      rootDir,
      existingIssues: [
        {
          number: 77,
          url: "https://github.com/example/repo/issues/77",
          dedupeFingerprint: firstIssue.dedupeFingerprint,
          title: firstIssue.title,
          labels: firstIssue.labels
        }
      ]
    });
    expect(publish.plan.decisions[0]).toMatchObject({ action: "update", status: "resolved_candidate", existingIssue: { number: 77 } });
    expect(publish.plan.decisions[0]?.labels).toContain("visual-hive/resolved-candidate");
    expect(publish.plan.decisions[0]?.body).toContain("Do not auto-close by default");
  });

  it("writes no-network issue publish plan and dry-run artifacts with dedupe decisions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-issue-publish-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"));
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "publish-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "publish-demo" });
    const issues = await writeIssuesArtifacts({ rootDir, project: "publish-demo" });
    const firstIssue = issues.report.issues[0]!;

    const publish = await writeIssuePublishArtifacts({
      rootDir,
      existingIssues: [
        {
          number: 12,
          url: "https://github.com/example/repo/issues/12?token=secret-value",
          dedupeFingerprint: firstIssue.dedupeFingerprint,
          title: firstIssue.title,
          labels: firstIssue.labels
        }
      ],
      now: new Date("2026-01-02T00:00:00.000Z")
    });

    expect(publish.plan.externalCallsMade).toBe(0);
    expect(publish.dryRun.networkCallsMade).toBe(0);
    expect(publish.result.realGithubIssuesCreated).toBe(0);
    expect(publish.plan.decisions[0]).toMatchObject({ action: "update", existingIssue: { number: 12 } });
    expect(JSON.stringify(publish)).not.toContain("secret-value");
    await expectMatchesSchema("visual-hive.issue-publish-plan.schema.json", publish.plan);
    await expectMatchesSchema("visual-hive.issue-publish-dry-run.schema.json", publish.dryRun);
    await expectMatchesSchema("visual-hive.issue-publish-result.schema.json", publish.result);

    await writeJson(path.join(rootDir, ".visual-hive", "hive-handoff-validation.json"), {
      schemaVersion: "visual-hive.handoff-validation.v1",
      generatedAt: "2026-01-02T00:00:00.000Z",
      project: "publish-demo",
      status: "blocked",
      sourceArtifacts: {
        evidencePacket: ".visual-hive/evidence-packet.json",
        handoff: ".visual-hive/handoff.json",
        issue: ".visual-hive/hive-issue.md",
        beadRequest: ".visual-hive/hive-bead-request.json",
        result: ".visual-hive/hive-handoff-result.json"
      },
      summary: { checksPassed: 0, warnings: 0, blocked: 1, externalCallsMade: 0, workItems: 0 },
      hiveReadiness: {
        recommendedMode: "missing",
        recommendedStatus: "missing",
        readyModes: [],
        trustedOnlyModes: [],
        blockedModes: [],
        trustedWorkflowRequiredModes: [],
        fullAutomationBlocked: true,
        guardedRepairTrustedOnlyOrBlocked: true
      },
      checks: [],
      blockedReasons: ["artifact validation failed"],
      warnings: []
    });
    const blocked = await writeIssuePublishArtifacts({ rootDir });
    expect(blocked.plan.status).toBe("blocked");
    expect(blocked.plan.decisions.every((decision) => decision.action === "blocked")).toBe(true);
  });

  it("blocks live issue publishing unless explicit trusted guards are present", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-issue-live-blocked-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"));
    await writeIssuesArtifacts({ rootDir, project: "live-blocked-demo" });
    let clientCalled = false;

    const publish = await writeIssuePublishArtifacts({
      rootDir,
      mode: "live",
      env: {},
      githubClient: {
        async listOpenIssues() {
          clientCalled = true;
          return [];
        },
        async createIssue() {
          clientCalled = true;
          throw new Error("should not create");
        },
        async updateIssue() {
          clientCalled = true;
          throw new Error("should not update");
        }
      }
    });

    expect(clientCalled).toBe(false);
    expect(publish.plan.status).toBe("blocked");
    expect(publish.result.status).toBe("blocked");
    expect(publish.result.externalCallsMade).toBe(0);
    expect(publish.result.networkCallsMade).toBe(0);
    expect(publish.result.realGithubIssuesCreated).toBe(0);
    expect(publish.result.realGithubIssuesUpdated).toBe(0);
    expect(publish.result.blockedReasons.join(" ")).toContain("VISUAL_HIVE_LIVE_GITHUB_ISSUE");
    expect(publish.result.blockedReasons.join(" ")).toContain("GITHUB_TOKEN");
    await expectMatchesSchema("visual-hive.issue-publish-result.schema.json", publish.result);
  });

  it("publishes live issues through a mock GitHub client with dedupe create and update decisions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-issue-live-mock-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"));
    const issues = await writeIssuesArtifacts({ rootDir, project: "live-mock-demo" });
    const first = issues.report.issues[0]!;
    const second = {
      ...first,
      dedupeFingerprint: `${first.dedupeFingerprint}:new`,
      title: `${first.title} duplicate proof`,
      body: first.body.replace(first.dedupeFingerprint, `${first.dedupeFingerprint}:new`)
    };
    await writeJson(path.join(rootDir, ".visual-hive", "issues.json"), {
      ...issues.report,
      summary: {
        ...issues.report.summary,
        total: 2,
        openCandidates: 2,
        byKind: { [first.issueKind]: 2 },
        bySeverity: { [first.severity]: 2 }
      },
      issues: [first, second]
    });
    const calls: string[] = [];

    const publish = await writeIssuePublishArtifacts({
      rootDir,
      mode: "live",
      githubRepository: "DavidDiaz0317/visual-hive-demo-site",
      env: {
        VISUAL_HIVE_LIVE_GITHUB_ISSUE: "true",
        GITHUB_TOKEN: "ghp_secret-token"
      },
      githubClient: {
        async listOpenIssues() {
          calls.push("list");
          return [
            {
              number: 42,
              url: "https://github.com/DavidDiaz0317/visual-hive-demo-site/issues/42?token=secret-token",
              dedupeFingerprint: first.dedupeFingerprint,
              title: first.title,
              labels: first.labels
            }
          ];
        },
        async createIssue(input) {
          calls.push(`create:${input.dedupeFingerprint}`);
          return {
            number: 43,
            url: "https://github.com/DavidDiaz0317/visual-hive-demo-site/issues/43",
            dedupeFingerprint: input.dedupeFingerprint,
            title: input.title,
            labels: input.labels
          };
        },
        async updateIssue(input) {
          calls.push(`update:${input.issueNumber}`);
          return {
            number: input.issueNumber,
            url: "https://github.com/DavidDiaz0317/visual-hive-demo-site/issues/42",
            dedupeFingerprint: input.dedupeFingerprint,
            title: input.title,
            labels: input.labels
          };
        }
      },
      now: new Date("2026-01-03T00:00:00.000Z")
    });

    expect(calls).toEqual(["list", "update:42", `create:${second.dedupeFingerprint}`]);
    expect(publish.plan.status).toBe("ready");
    expect(publish.plan.summary.update).toBe(1);
    expect(publish.plan.summary.create).toBe(1);
    expect(publish.result.status).toBe("published");
    expect(publish.result.mode).toBe("live");
    expect(publish.result.externalCallsMade).toBe(3);
    expect(publish.result.networkCallsMade).toBe(3);
    expect(publish.result.realGithubIssuesCreated).toBe(1);
    expect(publish.result.realGithubIssuesUpdated).toBe(1);
    expect(publish.result.createdIssues[0]?.number).toBe(43);
    expect(publish.result.updatedIssues[0]?.number).toBe(42);
    expect(JSON.stringify(publish)).not.toContain("secret-token");
    await expectMatchesSchema("visual-hive.issue-publish-plan.schema.json", publish.plan);
    await expectMatchesSchema("visual-hive.issue-publish-result.schema.json", publish.result);
  });

  it("filters issue publishing by dedupe, kind, severity, and limit before making live decisions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-issue-filtered-publish-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "report.json"), reportFixture(rootDir, ".visual-hive/artifacts/screenshots/dashboard.png", ".visual-hive/snapshots/dashboard.png"));
    const issues = await writeIssuesArtifacts({ rootDir, project: "filtered-publish-demo" });
    const first = issues.report.issues[0]!;
    const second = {
      ...first,
      dedupeFingerprint: `${first.dedupeFingerprint}:second`,
      title: `${first.title} second`,
      body: first.body.replace(first.dedupeFingerprint, `${first.dedupeFingerprint}:second`)
    };
    const third = {
      ...first,
      issueKind: "workflow_safety" as const,
      severity: "low" as const,
      dedupeFingerprint: `${first.dedupeFingerprint}:third`,
      title: `${first.title} third`,
      body: first.body.replace(first.dedupeFingerprint, `${first.dedupeFingerprint}:third`)
    };
    await writeJson(path.join(rootDir, ".visual-hive", "issues.json"), {
      ...issues.report,
      summary: {
        ...issues.report.summary,
        total: 3,
        openCandidates: 3,
        byKind: { [first.issueKind]: 2, workflow_safety: 1 },
        bySeverity: { [first.severity]: 2, low: 1 }
      },
      issues: [first, second, third]
    });

    const dryRun = await writeIssuePublishArtifacts({
      rootDir,
      issueKind: first.issueKind,
      minSeverity: first.severity,
      limit: 1
    });

    expect(dryRun.plan.summary.total).toBe(1);
    expect(dryRun.plan.decisions).toHaveLength(1);
    expect(dryRun.plan.decisions[0]?.dedupeFingerprint).toBe(first.dedupeFingerprint);
    expect(dryRun.dryRun.wouldCreateIssues).toBe(1);

    const calls: string[] = [];
    const live = await writeIssuePublishArtifacts({
      rootDir,
      mode: "live",
      dedupeFingerprint: first.dedupeFingerprint,
      githubRepository: "DavidDiaz0317/visual-hive-demo-site",
      env: {
        VISUAL_HIVE_LIVE_GITHUB_ISSUE: "true",
        GITHUB_TOKEN: "ghp_filtered-secret"
      },
      githubClient: {
        async listOpenIssues() {
          calls.push("list");
          return [
            {
              number: 44,
              url: "https://github.com/DavidDiaz0317/visual-hive-demo-site/issues/44?token=filtered-secret",
              dedupeFingerprint: first.dedupeFingerprint,
              title: first.title,
              labels: first.labels
            }
          ];
        },
        async createIssue() {
          calls.push("create");
          throw new Error("filtered publish should not create");
        },
        async updateIssue(input) {
          calls.push(`update:${input.issueNumber}`);
          return {
            number: input.issueNumber,
            url: "https://github.com/DavidDiaz0317/visual-hive-demo-site/issues/44",
            dedupeFingerprint: input.dedupeFingerprint,
            title: input.title,
            labels: input.labels
          };
        }
      },
      now: new Date("2026-01-03T01:00:00.000Z")
    });

    expect(calls).toEqual(["list", "update:44"]);
    expect(live.plan.summary.total).toBe(1);
    expect(live.plan.summary.update).toBe(1);
    expect(live.plan.summary.create).toBe(0);
    expect(live.result.realGithubIssuesCreated).toBe(0);
    expect(live.result.realGithubIssuesUpdated).toBe(1);
    expect(JSON.stringify(live)).not.toContain("filtered-secret");
    await expectMatchesSchema("visual-hive.issue-publish-plan.schema.json", live.plan);
    await expectMatchesSchema("visual-hive.issue-publish-result.schema.json", live.result);
  });

  it("writes a no-write issue-driven agent request bundle from an issue candidate", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-agent-issue-run-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "mutation-report.json"), {
      schemaVersion: 2,
      generatedAt: "2026-01-04T00:00:00.000Z",
      project: "agent-issue-demo",
      score: 0,
      total: 1,
      killed: 0,
      survived: 1,
      notApplicable: 0,
      minScore: 0.75,
      results: [
        {
          operator: "force-login-on-demo",
          status: "survived",
          killed: false,
          contractIds: ["hosted-demo-never-login"],
          selectedContracts: ["hosted-demo-never-login"],
          expectedFailureKinds: ["login_regression"],
          durationMs: 12,
          artifacts: [".visual-hive/mutation-report.json"],
          affectedSurfaces: [{ contractId: "hosted-demo-never-login", route: "/", selector: "[data-testid='login-page']", viewport: "desktop", targetId: "localPreview" }],
          validationCommand: "visual-hive mutate --operator force-login-on-demo",
          suggestedMissingTest: "Add a contract that forbids the login page on the hosted demo.",
          sourceMutation: false
        }
      ]
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "agent-issue-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "agent-issue-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "handoff.json"), { schemaVersion: "visual-hive.handoff.v1" });
    await writeJson(path.join(rootDir, ".visual-hive", "hive", "hive-export.json"), { schemaVersion: "visual-hive.hive-export.v1" });
    await writeJson(path.join(rootDir, ".visual-hive", "hive", "knowledge-graph.json"), { schemaVersion: "visual-hive.hive-knowledge-graph.v1" });
    const issues = await writeIssuesArtifacts({ rootDir, project: "agent-issue-demo" });
    const survivor = issues.report.issues.find((issue) => issue.issueKind === "mutation_survivor")!;

    const run = await writeAgentIssueRun({
      rootDir,
      project: "agent-issue-demo",
      dedupeFingerprint: survivor.dedupeFingerprint,
      codexDiscoveryRunner: async (command, args, timeoutMs) => ({
        status: 0,
        stdout: `${command} ${args.join(" ")}\nUsage: codex [options]\n  --model <model>\n`,
        stderr: `timeout=${timeoutMs}`,
        timedOut: false
      }),
      now: new Date("2026-01-04T00:00:00.000Z")
    });

    expect(run.run.profile).toBe("test_creator_agent");
    expect(run.run.mode).toBe("no_write");
    expect(run.run.budgets.allowWrite).toBe(false);
    expect(run.run.budgets.allowExternalNetwork).toBe(false);
    expect(run.run.codexCli).toMatchObject({
      command: "codex",
      discoveryStatus: "available"
    });
    expect(run.run.codexCli.helpExcerpt).toContain("Usage: codex");
    expect(run.run.safety).toMatchObject({
      sourceMutations: 0,
      branchesCreated: 0,
      pullRequestsOpened: 0,
      externalCallsMade: 0,
      networkCallsMade: 0,
      realGithubIssuesCreated: 0,
      hiveApiCallsMade: 0,
      llmCallsMade: 0,
      paidProviderCallsMade: 0
    });
    expect(run.run.parsedIssue.validationCommand).toBe("visual-hive mutate --operator force-login-on-demo");
    expect(run.requestMarkdown).toContain("Default run is advisory no-write");
    expect(run.requestMarkdown).toContain("Codex CLI Discovery");
    expect(run.requestMarkdown).toContain("## MCP Context Path");
    expect(run.requestMarkdown).toContain("visual_hive_get_issue_context");
    expect(run.requestMarkdown).toContain("## Visual Graph Refs");
    expect(run.requestMarkdown).toContain(".visual-hive/visual-graph.json");
    expect(run.requestMarkdown).toContain("## Impact Analysis");
    expect(run.requestMarkdown).toContain("## Allowed Actions");
    expect(run.requestMarkdown).toContain("## Forbidden Actions");
    expect(run.requestMarkdown).toContain("## Output Schema");
    expect(run.requestMarkdown).toContain("`diagnosis`");
    expect(run.requestMarkdown).toContain("`proposedFilesToInspect`");
    expect(run.requestMarkdown).toContain("`risks`");
    expect(run.requestMarkdown).toContain("`writeAccessNeeded`");
    expect(run.requestMarkdown).toContain("`confidence`");
    expect(run.requestMarkdown).toContain("Do not weaken screenshot thresholds");
    expect(run.outputMarkdown).toContain("did not run Codex as an agent");
    expect(run.outputMarkdown).toContain("Codex CLI Discovery");
    expect(run.outputMarkdown).toContain("Do not approve baselines blindly");
    await expectMatchesSchema("visual-hive.agent-issue-run.schema.json", run.run);
  });

  it("records unavailable Codex CLI discovery as a blocked no-write issue-agent artifact", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-agent-issue-unavailable-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "coverage-recommendations.json"), {
      schemaVersion: "visual-hive.coverage-recommendations.v1",
      generatedAt: "2026-01-04T00:00:00.000Z",
      project: "agent-issue-demo",
      recommendations: [
        {
          id: "coverage-gap-demo",
          issueKind: "missing_visual_coverage",
          severity: "medium",
          title: "Add changed-file selection for dashboard",
          description: "Dashboard contract is not selected by changed files.",
          contractId: "dashboard-contract",
          targetId: "localPreview"
        }
      ],
      maintenanceFindings: []
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "agent-issue-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "agent-issue-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "handoff.json"), { schemaVersion: "visual-hive.handoff.v1" });
    const issues = await writeIssuesArtifacts({ rootDir, project: "agent-issue-demo" });

    const run = await writeAgentIssueRun({
      rootDir,
      project: "agent-issue-demo",
      dedupeFingerprint: issues.report.issues[0]?.dedupeFingerprint,
      codexCommand: "missing-codex",
      codexDiscoveryRunner: async () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: "spawn missing-codex ENOENT"
      }),
      now: new Date("2026-01-04T00:00:00.000Z")
    });

    expect(run.run.status).toBe("blocked");
    expect(run.run.codexCli.discoveryStatus).toBe("unavailable");
    expect(run.run.codexCli.errorExcerpt).toContain("missing-codex");
    expect(run.run.blockedReasons.join(" ")).toContain("Codex CLI is unavailable");
    expect(run.run.safety.externalCallsMade).toBe(0);
    expect(run.run.safety.sourceMutations).toBe(0);
    expect(run.run.safety.branchesCreated).toBe(0);
    expect(run.run.safety.pullRequestsOpened).toBe(0);
    await expectMatchesSchema("visual-hive.agent-issue-run.schema.json", run.run);
  });

  it("allows deterministic local issue-agent execution when Codex discovery is unavailable", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-agent-issue-local-agent-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "coverage-recommendations.json"), {
      schemaVersion: "visual-hive.coverage-recommendations.v1",
      generatedAt: "2026-01-04T00:00:00.000Z",
      project: "agent-local-demo",
      recommendations: [
        {
          id: "coverage-gap-demo",
          issueKind: "missing_visual_coverage",
          severity: "medium",
          title: "Add dashboard visual coverage",
          description: "Dashboard route lacks coverage.",
          route: "/",
          targetId: "localPreview"
        }
      ],
      maintenanceFindings: []
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "agent-local-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "agent-local-demo" });
    const issues = await writeIssuesArtifacts({ rootDir, project: "agent-local-demo" });

    let agentRunnerCalled = false;
    const run = await writeAgentIssueRun({
      rootDir,
      project: "agent-local-demo",
      dedupeFingerprint: issues.report.issues[0]?.dedupeFingerprint,
      executeAgent: true,
      agentCommand: "node",
      agentArgs: ["scripts/local-issue-agent.mjs"],
      codexDiscoveryRunner: async () => ({ status: null, stdout: "", stderr: "", error: "spawn EPERM" }),
      agentRunner: async () => {
        agentRunnerCalled = true;
        return { status: 0, stdout: "local agent completed", stderr: "" };
      },
      now: new Date("2026-01-04T00:00:00.000Z")
    });

    expect(agentRunnerCalled).toBe(true);
    expect(run.run.status).toBe("completed");
    expect(run.run.codexCli.discoveryStatus).toBe("failed");
    expect(run.run.agentExecution.status).toBe("completed");
    expect(run.run.blockedReasons).toEqual([]);
    expect(run.run.safety.externalCallsMade).toBe(0);
    expect(run.run.safety.networkCallsMade).toBe(0);
    expect(run.run.safety.llmCallsMade).toBe(0);
    await expectMatchesSchema("visual-hive.agent-issue-run.schema.json", run.run);
  });

  it("routes deterministic failure issues to the repair planner agent profile", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-agent-repair-planner-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "issues.json"), {
      schemaVersion: "visual-hive.issues.v1",
      generatedAt: "2026-01-04T00:00:00.000Z",
      project: "agent-repair-demo",
      externalCallsMade: 0,
      networkCallsMade: 0,
      sourceArtifacts: {
        report: ".visual-hive/report.json",
        evidencePacket: ".visual-hive/evidence-packet.json",
        visualGraph: ".visual-hive/visual-graph.json",
        visualImpact: ".visual-hive/visual-impact.json"
      },
      summary: {
        total: 1,
        openCandidates: 1,
        updateCandidates: 0,
        resolvedCandidates: 0,
        suppressed: 0,
        blocked: 0,
        byKind: { visual_regression: 1 },
        bySeverity: { critical: 1 }
      },
      issues: [
        {
          issueKind: "visual_regression",
          severity: "critical",
          status: "open_candidate",
          dedupeFingerprint: "visual-hive:visual_regression:dashboard-shell",
          title: "[Visual Hive] Dashboard visual regression",
          labels: ["visual-hive", "visual-regression"],
          body: "Dashboard shell changed unexpectedly.",
          owningAgentHint: "hive/quality",
          sourceArtifacts: [".visual-hive/report.json", ".visual-hive/evidence-packet.json"],
          affected: [{ route: "/", component: "Dashboard", contractId: "dashboard-visual-stability", viewport: "desktop" }],
          reproductionCommand: "visual-hive run --ci",
          validationCommand: "visual-hive run --ci && visual-hive evidence",
          linkedEvidencePacket: ".visual-hive/evidence-packet.json",
          linkedRepoMap: ".visual-hive/repo-map.json",
          linkedVisualGraph: ".visual-hive/visual-graph.json",
          linkedVisualImpact: ".visual-hive/visual-impact.json",
          guardrails: [
            "Do not approve baselines blindly.",
            "Do not weaken screenshot thresholds."
          ]
        }
      ]
    });

    const run = await writeAgentIssueRun({
      rootDir,
      project: "agent-repair-demo",
      issueIndex: 0,
      codexDiscoveryRunner: async () => ({ status: 0, stdout: "Usage: codex", stderr: "" }),
      now: new Date("2026-01-04T00:00:00.000Z")
    });

    expect(run.run.profile).toBe("repair_planner_agent");
    expect(run.run.parsedIssue.affectedContracts).toContain("dashboard-visual-stability");
    expect(run.requestMarkdown).toContain("repair_planner_agent");
    expect(run.requestMarkdown).toContain("visual-hive run --ci && visual-hive evidence");
    expect(run.run.recommendations.join(" ")).toContain("bounded repair plan");
    await expectMatchesSchema("visual-hive.agent-issue-run.schema.json", run.run);
  });

  it("validates no-write agent artifacts and catches forbidden action counters", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-agent-validation-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "coverage-recommendations.json"), {
      schemaVersion: "visual-hive.coverage-recommendations.v1",
      generatedAt: "2026-01-04T00:00:00.000Z",
      project: "agent-validation-demo",
      recommendations: [
        {
          id: "coverage-gap-demo",
          issueKind: "missing_visual_coverage",
          severity: "medium",
          title: "Add dashboard visual coverage",
          description: "Dashboard route lacks coverage.",
          route: "/",
          targetId: "localPreview"
        }
      ],
      maintenanceFindings: []
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "agent-validation-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "agent-validation-demo" });
    const issues = await writeIssuesArtifacts({ rootDir, project: "agent-validation-demo" });
    const run = await writeAgentIssueRun({
      rootDir,
      project: "agent-validation-demo",
      dedupeFingerprint: issues.report.issues[0]?.dedupeFingerprint,
      codexDiscoveryRunner: async () => ({ status: 0, stdout: "Usage: codex", stderr: "" }),
      now: new Date("2026-01-04T00:00:00.000Z")
    });

    const passed = await validateAgentArtifacts({
      rootDir,
      now: new Date("2026-01-04T00:00:00.000Z"),
      outputPath: ".visual-hive/agent-validation.json"
    });

    expect(passed.report.status).toBe("passed");
    expect(passed.report.summary).toMatchObject({
      agentRuns: 1,
      failed: 0,
      forbiddenActionFailures: 0
    });
    expect(passed.report.items[0]?.requestPath).toMatch(/^\.visual-hive\//);
    await expect(readFile(path.join(rootDir, ".visual-hive", "agent-validation.json"), "utf8")).resolves.toContain("visual-hive.agent-artifacts-validation.v1");

    await writeJson(run.runPath, {
      ...run.run,
      safety: {
        ...run.run.safety,
        branchesCreated: 1
      }
    });

    const failed = await validateAgentArtifacts({ rootDir, now: new Date("2026-01-04T00:00:00.000Z") });
    expect(failed.report.status).toBe("failed");
    expect(failed.report.summary.forbiddenActionFailures).toBe(1);
    expect(failed.report.items[0]?.checks.find((check) => check.id === "forbidden_branchesCreated")).toMatchObject({
      status: "failed"
    });
  });

  it("runs a guarded local issue-agent command with bounded no-network evidence", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-agent-issue-exec-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "coverage-recommendations.json"), {
      schemaVersion: "visual-hive.coverage-recommendations.v1",
      generatedAt: "2026-01-04T00:00:00.000Z",
      project: "agent-exec-demo",
      recommendations: [
        {
          id: "coverage-gap-demo",
          issueKind: "missing_visual_coverage",
          severity: "high",
          title: "Add visual coverage for the command matrix",
          description: "Command matrix route lacks a focused visual contract.",
          route: "/commands",
          contractId: "command-matrix-contract",
          targetId: "localPreview"
        }
      ],
      maintenanceFindings: []
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "agent-exec-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "agent-exec-demo" });
    const issues = await writeIssuesArtifacts({ rootDir, project: "agent-exec-demo" });

    const run = await writeAgentIssueRun({
      rootDir,
      project: "agent-exec-demo",
      dedupeFingerprint: issues.report.issues[0]?.dedupeFingerprint,
      executeAgent: true,
      agentCommand: "local-agent",
      agentArgs: ["--no-write"],
      agentTimeoutMs: 1000,
      codexDiscoveryRunner: async () => ({ status: 0, stdout: "Usage: codex", stderr: "" }),
      agentRunner: async ({ command, args, env, stdin }) => {
        expect(command).toBe("local-agent");
        expect(args).toEqual(["--no-write"]);
        expect(env.VISUAL_HIVE_AGENT_PROFILE).toBe("test_creator_agent");
        expect(env.VISUAL_HIVE_AGENT_ALLOW_WRITE).toBe("false");
        expect(stdin).toContain("Add visual coverage for the command matrix");
        return {
          status: 0,
          stdout: "Proposed contract: assert [data-testid='command-matrix'] and capture desktop screenshot.",
          stderr: ""
        };
      },
      now: new Date("2026-01-04T00:00:00.000Z")
    });

    expect(run.run.status).toBe("completed");
    expect(run.run.agentExecution).toMatchObject({
      enabled: true,
      command: "local-agent",
      args: ["--no-write"],
      status: "completed"
    });
    expect(run.outputMarkdown).toContain("Proposed contract");
    expect(run.run.safety).toMatchObject({
      sourceMutations: 0,
      externalCallsMade: 0,
      networkCallsMade: 0,
      llmCallsMade: 0,
      realGithubIssuesCreated: 0
    });
    await expectMatchesSchema("visual-hive.agent-issue-run.schema.json", run.run);
  });

  it("blocks Codex issue-agent execution unless external network and explicit args are configured", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-agent-issue-codex-block-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "coverage-recommendations.json"), {
      schemaVersion: "visual-hive.coverage-recommendations.v1",
      generatedAt: "2026-01-04T00:00:00.000Z",
      project: "agent-codex-block-demo",
      recommendations: [
        {
          id: "coverage-gap-demo",
          issueKind: "missing_visual_coverage",
          severity: "medium",
          title: "Add dashboard visual coverage",
          description: "Dashboard route lacks coverage.",
          route: "/",
          targetId: "localPreview"
        }
      ],
      maintenanceFindings: []
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "agent-codex-block-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "agent-codex-block-demo" });
    const issues = await writeIssuesArtifacts({ rootDir, project: "agent-codex-block-demo" });
    let agentRunnerCalled = false;

    const run = await writeAgentIssueRun({
      rootDir,
      project: "agent-codex-block-demo",
      dedupeFingerprint: issues.report.issues[0]?.dedupeFingerprint,
      executeAgent: true,
      codexCommand: "codex",
      codexDiscoveryRunner: async () => ({ status: 0, stdout: "Usage: codex", stderr: "" }),
      agentRunner: async () => {
        agentRunnerCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
      now: new Date("2026-01-04T00:00:00.000Z")
    });

    expect(agentRunnerCalled).toBe(false);
    expect(run.run.status).toBe("blocked");
    expect(run.run.agentExecution.status).toBe("blocked");
    expect(run.run.agentExecution.errorExcerpt).toContain("external network");
    expect(run.run.safety.networkCallsMade).toBe(0);
    expect(run.outputMarkdown).toContain("did not complete an agent command successfully");
    await expectMatchesSchema("visual-hive.agent-issue-run.schema.json", run.run);
  });

  it("does not count failed Codex spawn as an external network or LLM call", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "visual-hive-agent-issue-codex-eperm-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, ".visual-hive"), { recursive: true });
    await writeJson(path.join(rootDir, ".visual-hive", "coverage-recommendations.json"), {
      schemaVersion: "visual-hive.coverage-recommendations.v1",
      generatedAt: "2026-01-04T00:00:00.000Z",
      project: "agent-codex-eperm-demo",
      recommendations: [
        {
          id: "coverage-gap-demo",
          issueKind: "missing_visual_coverage",
          severity: "medium",
          title: "Add dashboard visual coverage",
          description: "Dashboard route lacks coverage.",
          route: "/",
          targetId: "localPreview"
        }
      ],
      maintenanceFindings: []
    });
    await writeJson(path.join(rootDir, ".visual-hive", "evidence-packet.json"), { project: "agent-codex-eperm-demo" });
    await writeJson(path.join(rootDir, ".visual-hive", "repo-map.json"), { project: "agent-codex-eperm-demo" });
    const issues = await writeIssuesArtifacts({ rootDir, project: "agent-codex-eperm-demo" });

    let agentRunnerCalled = false;
    const run = await writeAgentIssueRun({
      rootDir,
      project: "agent-codex-eperm-demo",
      dedupeFingerprint: issues.report.issues[0]?.dedupeFingerprint,
      executeAgent: true,
      codexCommand: "codex",
      agentArgs: ["--help"],
      allowExternalNetwork: true,
      maxExternalCostUsd: 0,
      codexDiscoveryRunner: async () => ({ status: null, stdout: "", stderr: "", error: "spawn EPERM" }),
      agentRunner: async () => {
        agentRunnerCalled = true;
        return { status: null, stdout: "", stderr: "", error: "spawn EPERM" };
      },
      now: new Date("2026-01-04T00:00:00.000Z")
    });

    expect(agentRunnerCalled).toBe(false);
    expect(run.run.status).toBe("blocked");
    expect(run.run.agentExecution.status).toBe("blocked");
    expect(run.run.agentExecution.errorExcerpt).toContain("spawn EPERM");
    expect(run.run.blockedReasons.join(" ")).toContain("Codex CLI discovery failed");
    expect(run.run.recommendations.join(" ")).toContain("--codex-command");
    expect(run.run.recommendations.join(" ")).toContain("repo-local deterministic agent");
    expect(run.run.recommendations.join(" ")).toContain("WindowsApps");
    expect(run.outputMarkdown).toContain("--codex-command");
    expect(run.run.safety.externalCallsMade).toBe(0);
    expect(run.run.safety.networkCallsMade).toBe(0);
    expect(run.run.safety.llmCallsMade).toBe(0);
    await expectMatchesSchema("visual-hive.agent-issue-run.schema.json", run.run);
  });
});
