import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  buildHiveExportArtifacts,
  buildHiveGuardedRepairPreview,
  buildHiveModeComparison,
  buildHiveRepairRequestEnvelope,
  buildHiveTrustedRepairConsumerSummary,
  buildHiveTrustedRepairWorkflowDryRun
} from "../src/hive/build.js";
import type { EvidencePacket } from "../src/evidence/types.js";
import type { HandoffPacket } from "../src/handoff/types.js";
import { VISUAL_HIVE_EVIDENCE_RESOURCES } from "../src/tools/evidenceResources.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function expectMatchesSchema(schemaName: string, value: unknown): Promise<void> {
  const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", schemaName), "utf8")) as Record<string, unknown>;
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  expect(validate(value), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

describe("Hive native export", () => {
  it("keeps advisory mode issue-context only and no-network", () => {
    const result = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: {
        enabled: false,
        mode: "advisory"
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.bundle.mode).toBe("advisory");
    expect(result.bundle.externalCallsMade).toBe(0);
    expect(result.bundle.summary.beads).toBe(0);
    expect(result.bundle.summary.knowledgeFacts).toBe(0);
    expect(result.bundle.summary.repairWorkOrders).toBe(0);
    expect(result.issueContext).toContain("Hive Agent Work Order");
    expect(result.issueContext).not.toContain("secret-value");
  });

  it("maps deterministic and mutation evidence into measured Hive beads, facts, and graph nodes", () => {
    const result = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: {
        enabled: false,
        mode: "measured",
        export: {
          beads: true,
          knowledgeFacts: true,
          knowledgeGraph: true,
          wikiVault: true,
          repairWorkOrders: true,
          maxFacts: 20
        }
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.bundle.summary.beads).toBeGreaterThanOrEqual(2);
    expect(result.bundle.beads.find((bead) => bead.type === "bug")?.actor).toBe("quality");
    expect(result.bundle.beads.find((bead) => bead.type === "task")?.metadata.visual_hive_operator).toBe("force-login-on-demo");
    expect(result.bundle.knowledgeFacts.map((fact) => fact.type)).toEqual(expect.arrayContaining(["regression", "coverage_rule", "decision"]));
    expect(result.bundle.providerEvidence[0]).toMatchObject({
      providerId: "argos",
      uploadStatus: "failed",
      externalCallsMade: 1,
      stagedArtifacts: 2
    });
    expect(result.bundle.knowledgeFacts.map((fact) => fact.source)).toContain("visual-hive:provider-evidence");
    expect(result.issueContext).toContain("## Provider Evidence");
    expect(result.bundle.knowledgeGraph.nodes.length).toBeGreaterThan(0);
    expect(result.bundle.knowledgeGraph.edges.every((edge) => nodeIds(result).has(edge.from) && nodeIds(result).has(edge.to))).toBe(true);
    expect(result.bundle.summary.wikiPages).toBe(result.wikiPages.length);
    expect(result.bundle.wikiIndex.pages.length).toBe(result.wikiPages.length);
    expect(result.bundle.wikiIndex.pages[0]?.path).toMatch(/^\.visual-hive\/hive\/wiki\/.+\.md$/);
    expect(JSON.stringify(result.bundle)).not.toContain("secret-value");
  });

  it("emits one advisory UX Scout bead for selected affected flows", () => {
    const result = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      handoffPacketPath: ".visual-hive/handoff.json",
      handoffPacket: {
        ...({} as HandoffPacket),
        workItems: [],
        uxScoutContext: {
          schemaVersion: "visual-hive.ux-scout-context.v1",
          generatedAt: "2026-07-02T00:00:00.000Z",
          project: "hive-export-fixture",
          trigger: "affected-flow",
          visualHiveVerdict: "failed",
          changedFiles: ["src/App.tsx"],
          affectedFlows: [
            {
              id: "api-error-state-contract",
              contractId: "api-error-state-contract",
              targetId: "localPreview",
              severity: "high",
              selected: true,
              status: "failed",
              routes: ["/scenarios?issue=api-500"],
              selectors: ["[data-testid='error-banner']"],
              changedFiles: ["src/App.tsx"],
              failedSteps: [],
              evidence: [".visual-hive/flows.json#api-error-state-contract"]
            }
          ],
          sourceArtifacts: [".visual-hive/flows.json", ".visual-hive/hand-off.json"],
          guardrails: ["Visual Hive remains the deterministic verdict authority."]
        }
      } as HandoffPacket,
      hiveConfig: { enabled: false, mode: "measured" },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    const uxBead = result.bundle.beads.find((bead) => bead.actor === "ux-scout");
    expect(uxBead).toMatchObject({
      type: "advisory",
      status: "open",
      metadata: {
        visual_hive_agent: "ux-scout",
        ux_scout_context: ".visual-hive/ux-scout-context.json",
        ux_scout_flow_ids: "api-error-state-contract"
      }
    });
    expect(uxBead?.notes).toContain("Tier A code/text review");
    expect(result.bundle.governance.verdictAuthority).toBe("visual_hive");
  });

  it("creates guarded repair work orders with Visual Hive rerun acceptance criteria", () => {
    const result = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: {
        enabled: true,
        mode: "repair_request",
        repair: {
          enabled: true,
          prOnly: true,
          maxAttempts: 1,
          requireHumanReview: true,
          rerunVisualHive: true,
          branchPrefix: "hive/visual-hive-"
        }
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.bundle.summary.repairWorkOrders).toBeGreaterThan(0);
    expect(result.bundle.repairWorkOrders[0]?.acceptanceCriteria).toContain("Visual Hive verdict passes after repair.");
    expect(result.bundle.repairWorkOrders[0]?.forbiddenActions).toContain("auto_merge_without_visual_hive_pass");
    expect(result.bundle.agentPolicy.finalValidation.passFailOwnedBy).toBe("visual_hive_verdict_engine");
  });

  it("blocks guarded repair export unless explicit trusted repair policy is configured", () => {
    const result = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: {
        enabled: false,
        mode: "guarded_repair"
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.bundle.mode).toBe("guarded_repair");
    expect(result.bundle.status).toBe("blocked");
    expect(result.bundle.externalCallsMade).toBe(0);
    expect(result.bundle.blockedReasons).toEqual(
      expect.arrayContaining([
        "Guarded Hive repair requires integrations.hive.enabled=true in a trusted workflow.",
        "Guarded Hive repair requires integrations.hive.repair.enabled=true.",
        "Guarded Hive repair requires ACMM level 5 or higher."
      ])
    );
  });

  it("matches the tracked Hive export JSON schema", async () => {
    const result = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: { enabled: true, mode: "repair_request" },
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    await expectMatchesSchema("visual-hive.hive-export.schema.json", result.bundle);
    await expectMatchesSchema("visual-hive.hive-beads.schema.json", result.bundle.beads);
    await expectMatchesSchema("visual-hive.hive-knowledge-facts.schema.json", result.bundle.knowledgeFacts);
    await expectMatchesSchema("visual-hive.hive-knowledge-graph.schema.json", result.bundle.knowledgeGraph);
    await expectMatchesSchema("visual-hive.hive-wiki-index.schema.json", result.bundle.wikiIndex);
    await expectMatchesSchema("visual-hive.hive-repair-work-orders.schema.json", result.bundle.repairWorkOrders);
    await expectMatchesSchema("visual-hive.hive-agent-policy.schema.json", result.bundle.agentPolicy);
  });

  it("maps Hive output artifacts to catalog-backed read-only evidence resources", () => {
    const result = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: { enabled: true, mode: "repair_request" },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.bundle.outputResources).toEqual([
      expect.objectContaining({
        artifactKey: "export",
        artifactPath: ".visual-hive/hive/hive-export.json",
        evidenceResourceId: "hive-export",
        evidenceResourceUri: "visual-hive://hive-export",
        evidenceReadToolName: "visual_hive_read_hive_export"
      }),
      expect.objectContaining({
        artifactKey: "beads",
        artifactPath: ".visual-hive/hive/beads.json",
        evidenceResourceId: "hive-beads",
        evidenceResourceUri: "visual-hive://hive-beads",
        evidenceReadToolName: "visual_hive_read_hive_beads"
      }),
      expect.objectContaining({
        artifactKey: "knowledgeFacts",
        artifactPath: ".visual-hive/hive/knowledge-facts.json",
        evidenceResourceId: "hive-knowledge-facts",
        evidenceResourceUri: "visual-hive://hive/knowledge-facts",
        evidenceReadToolName: "visual_hive_read_hive_knowledge_facts"
      }),
      expect.objectContaining({
        artifactKey: "knowledgeGraph",
        artifactPath: ".visual-hive/hive/knowledge-graph.json",
        evidenceResourceId: "hive-knowledge-graph",
        evidenceResourceUri: "visual-hive://hive/knowledge-graph",
        evidenceReadToolName: "visual_hive_read_hive_knowledge_graph"
      }),
      expect.objectContaining({
        artifactKey: "wikiIndex",
        artifactPath: ".visual-hive/hive/wiki-index.json",
        evidenceResourceId: "hive-wiki-index",
        evidenceResourceUri: "visual-hive://hive/wiki-index",
        evidenceReadToolName: "visual_hive_read_hive_wiki_index"
      }),
      expect.objectContaining({
        artifactKey: "repairWorkOrders",
        artifactPath: ".visual-hive/hive/repair-work-orders.json",
        evidenceResourceId: "hive-repair-work-orders",
        evidenceResourceUri: "visual-hive://hive/repair-work-orders",
        evidenceReadToolName: "visual_hive_read_hive_repair_work_orders"
      }),
      expect.objectContaining({
        artifactKey: "agentPolicy",
        artifactPath: ".visual-hive/hive/hive-agent-policy.json",
        evidenceResourceId: "hive-agent-policy",
        evidenceResourceUri: "visual-hive://hive/agent-policy",
        evidenceReadToolName: "visual_hive_read_hive_agent_policy"
      })
    ]);
  });

  it("keeps Hive output-resource schema enums aligned with the evidence-resource catalog", async () => {
    const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.hive-export.schema.json"), "utf8")) as {
      $defs: {
        outputResource: {
          properties: {
            evidenceResourceId: { enum: string[] };
            evidenceResourceUri: { enum: string[] };
            evidenceReadToolName: { enum: string[] };
          };
        };
      };
    };
    const hiveExportResourceIds = [
      "hive-export",
      "hive-beads",
      "hive-knowledge-facts",
      "hive-knowledge-graph",
      "hive-wiki-index",
      "hive-repair-work-orders",
      "hive-agent-policy"
    ];
    const hiveExportResources = hiveExportResourceIds.map((id) => {
      const resource = VISUAL_HIVE_EVIDENCE_RESOURCES.find((candidate) => candidate.id === id);
      expect(resource, `Missing evidence resource ${id}`).toBeDefined();
      return resource!;
    });

    expect(schema.$defs.outputResource.properties.evidenceResourceId.enum).toEqual(hiveExportResources.map((resource) => resource.id));
    expect(schema.$defs.outputResource.properties.evidenceResourceUri.enum).toEqual(hiveExportResources.map((resource) => resource.uri));
    expect(schema.$defs.outputResource.properties.evidenceReadToolName.enum).toEqual(hiveExportResources.map((resource) => resource.readTool?.name));
  });

  it("builds a no-network guarded repair preview from repair-request export policy", async () => {
    const exportResult = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: {
        enabled: true,
        mode: "repair_request",
        repair: {
          enabled: true,
          prOnly: true,
          maxAttempts: 1,
          requireHumanReview: true,
          rerunVisualHive: true,
          branchPrefix: "hive/visual-hive-"
        }
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    const preview = buildHiveGuardedRepairPreview({
      hiveExport: exportResult.bundle,
      hiveExportPath: ".visual-hive/hive/hive-export.json",
      now: new Date("2026-07-02T00:01:00.000Z")
    });

    expect(preview.schemaVersion).toBe("visual-hive.hive-guarded-repair-preview.v1");
    expect(preview.externalCallsMade).toBe(0);
    expect(preview.status).toBe("ready");
    expect(preview.policy.repairExecution).toBe("preview_only_no_execution");
    expect(preview.policy.verdictAuthority).toBe("visual_hive");
    expect(preview.readiness.canRequestGuardedRepair).toBe(true);
    expect(preview.readiness.requiredCommands).toContain("visual-hive pipeline --mode pr --ci");
    expect(preview.summary.repairWorkOrders).toBeGreaterThan(0);
    expect(preview.workOrders[0]?.branchName).toContain("hive/visual-hive-");
    expect(preview.workOrders[0]?.forbiddenActions).toContain("decide_visual_hive_verdict");
    expect(JSON.stringify(preview)).not.toContain("secret-value");
  });

  it("matches the tracked Hive guarded repair preview JSON schema", async () => {
    const exportResult = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: {
        enabled: true,
        mode: "repair_request",
        repair: { enabled: true, prOnly: true, requireHumanReview: true, rerunVisualHive: true, maxAttempts: 1, branchPrefix: "hive/visual-hive-" }
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    const preview = buildHiveGuardedRepairPreview({
      hiveExport: exportResult.bundle,
      hiveExportPath: ".visual-hive/hive/hive-export.json",
      now: new Date("2026-07-02T00:01:00.000Z")
    });
    const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.hive-guarded-repair-preview.schema.json"), "utf8")) as Record<string, unknown>;
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    expect(validate(preview), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("builds a no-network trusted repair request envelope from guarded repair preview", () => {
    const exportResult = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: {
        enabled: true,
        mode: "repair_request",
        repair: { enabled: true, prOnly: true, requireHumanReview: true, rerunVisualHive: true, maxAttempts: 1, branchPrefix: "hive/visual-hive-" }
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    const preview = buildHiveGuardedRepairPreview({
      hiveExport: exportResult.bundle,
      hiveExportPath: ".visual-hive/hive/hive-export.json",
      now: new Date("2026-07-02T00:01:00.000Z")
    });
    const envelope = buildHiveRepairRequestEnvelope({
      guardedRepairPreview: preview,
      guardedRepairPreviewPath: ".visual-hive/hive/guarded-repair-preview.json",
      now: new Date("2026-07-02T00:02:00.000Z")
    });

    expect(envelope.schemaVersion).toBe("visual-hive.hive-repair-request-envelope.v1");
    expect(envelope.externalCallsMade).toBe(0);
    expect(envelope.status).toBe("ready");
    expect(envelope.policy.verdictAuthority).toBe("visual_hive");
    expect(envelope.policy.requestExecution).toBe("trusted_workflow_request_only");
    expect(envelope.policy.repairExecution).toBe("not_executed_by_visual_hive");
    expect(envelope.readiness.canOpenTrustedRepairRequest).toBe(true);
    expect(envelope.github.branchPrefix).toBe("hive/visual-hive-");
    expect(envelope.requests[0]?.finalValidationCommand).toBe("visual-hive pipeline --mode pr --ci");
    expect(envelope.requests[0]?.forbiddenActions).toContain("decide_visual_hive_verdict");
    expect(JSON.stringify(envelope)).not.toContain("secret-value");
  });

  it("matches the tracked Hive repair request envelope JSON schema", async () => {
    const exportResult = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: {
        enabled: true,
        mode: "repair_request",
        repair: { enabled: true, prOnly: true, requireHumanReview: true, rerunVisualHive: true, maxAttempts: 1, branchPrefix: "hive/visual-hive-" }
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    const preview = buildHiveGuardedRepairPreview({
      hiveExport: exportResult.bundle,
      hiveExportPath: ".visual-hive/hive/hive-export.json",
      now: new Date("2026-07-02T00:01:00.000Z")
    });
    const envelope = buildHiveRepairRequestEnvelope({
      guardedRepairPreview: preview,
      guardedRepairPreviewPath: ".visual-hive/hive/guarded-repair-preview.json",
      now: new Date("2026-07-02T00:02:00.000Z")
    });
    const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.hive-repair-request-envelope.schema.json"), "utf8")) as Record<string, unknown>;
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    expect(validate(envelope), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("matches the tracked trusted repair consumer summary JSON schema", async () => {
    const exportResult = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: {
        enabled: true,
        mode: "repair_request",
        repair: { enabled: true, prOnly: true, requireHumanReview: true, rerunVisualHive: true, maxAttempts: 1, branchPrefix: "hive/visual-hive-" }
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    const preview = buildHiveGuardedRepairPreview({
      hiveExport: exportResult.bundle,
      hiveExportPath: ".visual-hive/hive/hive-export.json",
      now: new Date("2026-07-02T00:01:00.000Z")
    });
    const envelope = buildHiveRepairRequestEnvelope({
      guardedRepairPreview: preview,
      guardedRepairPreviewPath: ".visual-hive/hive/guarded-repair-preview.json",
      now: new Date("2026-07-02T00:02:00.000Z")
    });
    const summary = buildHiveTrustedRepairConsumerSummary({
      repairRequestEnvelope: envelope,
      repairRequestEnvelopePath: ".visual-hive/hive/repair-request-envelope.json",
      now: new Date("2026-07-02T00:03:00.000Z")
    });

    expect(summary.schemaVersion).toBe("visual-hive.hive-trusted-repair-consumer-summary.v1");
    expect(summary.externalCallsMade).toBe(0);
    expect(summary.policy).toMatchObject({
      checkoutCode: false,
      branchCreation: false,
      pullRequestCreation: false,
      issueCreation: false,
      hiveNetworkCalls: false,
      providerCalls: false,
      visualHiveRerun: false
    });
    expect(summary.consumerActions).toMatchObject({
      wouldCheckoutCode: false,
      wouldExecuteRepair: false,
      wouldCreateBranches: false,
      wouldOpenPullRequests: false,
      wouldCreateIssues: false,
      wouldCallHiveApi: false,
      wouldCallProviders: false,
      wouldRunVisualHive: false
    });

    const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.hive-trusted-repair-consumer-summary.schema.json"), "utf8")) as Record<string, unknown>;
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    expect(validate(summary), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("builds a no-network trusted repair workflow dry-run from the consumer summary", async () => {
    const exportResult = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: {
        enabled: true,
        mode: "repair_request",
        repair: { enabled: true, prOnly: true, requireHumanReview: true, rerunVisualHive: true, maxAttempts: 1, branchPrefix: "hive/visual-hive-" }
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    const preview = buildHiveGuardedRepairPreview({
      hiveExport: exportResult.bundle,
      hiveExportPath: ".visual-hive/hive/hive-export.json",
      now: new Date("2026-07-02T00:01:00.000Z")
    });
    const envelope = buildHiveRepairRequestEnvelope({
      guardedRepairPreview: preview,
      guardedRepairPreviewPath: ".visual-hive/hive/guarded-repair-preview.json",
      now: new Date("2026-07-02T00:02:00.000Z")
    });
    const summary = buildHiveTrustedRepairConsumerSummary({
      repairRequestEnvelope: envelope,
      repairRequestEnvelopePath: ".visual-hive/hive/repair-request-envelope.json",
      now: new Date("2026-07-02T00:03:00.000Z")
    });
    const dryRun = buildHiveTrustedRepairWorkflowDryRun({
      trustedRepairConsumerSummary: summary,
      trustedRepairConsumerSummaryPath: ".visual-hive/hive/trusted-repair-consumer-summary.json",
      now: new Date("2026-07-02T00:04:00.000Z")
    });

    expect(dryRun.schemaVersion).toBe("visual-hive.hive-trusted-repair-workflow-dry-run.v1");
    expect(dryRun.externalCallsMade).toBe(0);
    expect(dryRun.status).toBe("ready");
    expect(dryRun.policy).toMatchObject({
      verdictAuthority: "visual_hive",
      workflowExecution: "dry_run_only",
      repairExecution: "not_executed_by_visual_hive",
      checkoutCode: false,
      branchCreation: false,
      pullRequestCreation: false,
      issueCreation: false,
      hiveNetworkCalls: false,
      providerCalls: false,
      visualHiveRerun: false
    });
    expect(dryRun.currentActions).toEqual({
      checkedOutCode: false,
      createdBranches: false,
      openedPullRequests: false,
      createdIssues: false,
      calledHiveApi: false,
      calledProviders: false,
      ranVisualHive: false,
      executedRepair: false
    });
    expect(summary.policy).toMatchObject({
      checkoutCode: false,
      providerCalls: false,
      visualHiveRerun: false
    });
    expect(summary.consumerActions).toMatchObject({
      wouldCheckoutCode: false,
      wouldExecuteRepair: false,
      wouldCallProviders: false
    });
    expect(dryRun.readiness.canRunTrustedRepairWorkflow).toBe(true);
    expect(dryRun.summary.plannedActions).toBeGreaterThan(0);
    expect(dryRun.items[0]?.plannedActions.every((action) => action.futureTrustedOnly)).toBe(true);
    expect(dryRun.items[0]?.plannedActions.map((action) => action.id)).toEqual(
      expect.arrayContaining(["download-visual-hive-artifacts", "create-repair-branch", "run-hive-repair-agent", "run-final-validation", "open-repair-pull-request"])
    );
    expect(JSON.stringify(dryRun)).not.toContain("secret-value");

    const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.hive-trusted-repair-workflow-dry-run.schema.json"), "utf8")) as Record<string, unknown>;
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    expect(validate(dryRun), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("maps Hive repair-chain artifacts to catalog-backed read-only evidence resources", () => {
    const exportResult = buildHiveExportArtifacts({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: {
        enabled: true,
        mode: "repair_request",
        repair: { enabled: true, prOnly: true, requireHumanReview: true, rerunVisualHive: true, maxAttempts: 1, branchPrefix: "hive/visual-hive-" }
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    const preview = buildHiveGuardedRepairPreview({
      hiveExport: exportResult.bundle,
      hiveExportPath: ".visual-hive/hive/hive-export.json",
      now: new Date("2026-07-02T00:01:00.000Z")
    });
    const envelope = buildHiveRepairRequestEnvelope({
      guardedRepairPreview: preview,
      guardedRepairPreviewPath: ".visual-hive/hive/guarded-repair-preview.json",
      now: new Date("2026-07-02T00:02:00.000Z")
    });
    const summary = buildHiveTrustedRepairConsumerSummary({
      repairRequestEnvelope: envelope,
      repairRequestEnvelopePath: ".visual-hive/hive/repair-request-envelope.json",
      now: new Date("2026-07-02T00:03:00.000Z")
    });
    const dryRun = buildHiveTrustedRepairWorkflowDryRun({
      trustedRepairConsumerSummary: summary,
      trustedRepairConsumerSummaryPath: ".visual-hive/hive/trusted-repair-consumer-summary.json",
      now: new Date("2026-07-02T00:04:00.000Z")
    });
    const comparison = buildHiveModeComparison({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: { enabled: true },
      now: new Date("2026-07-02T00:00:00.000Z")
    }).comparison;

    expectCatalogOutputResource(preview.outputResource, "preview", ".visual-hive/hive/guarded-repair-preview.json", "hive-guarded-repair-preview");
    expectCatalogOutputResource(envelope.outputResource, "envelope", ".visual-hive/hive/repair-request-envelope.json", "hive-repair-request-envelope");
    expectCatalogOutputResource(summary.outputResource, "summary", ".visual-hive/hive/trusted-repair-consumer-summary.json", "hive-trusted-repair-consumer-summary");
    expectCatalogOutputResource(dryRun.outputResource, "dryRun", ".visual-hive/hive/trusted-repair-workflow-dry-run.json", "hive-trusted-repair-workflow-dry-run");
    expectCatalogOutputResource(comparison.outputResource, "comparison", ".visual-hive/hive/mode-comparison.json", "hive-mode-comparison");
  }, 15_000);

  it("compares no-network Hive export modes and recommends repair request when work orders exist", async () => {
    const result = buildHiveModeComparison({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      handoffPacketPath: ".visual-hive/handoff.json",
      hiveConfig: {
        enabled: true,
        mode: "advisory"
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.comparison.schemaVersion).toBe("visual-hive.hive-mode-comparison.v1");
    expect(result.comparison.externalCallsMade).toBe(0);
    expect(result.comparison.modes.map((mode) => mode.mode)).toEqual(["advisory", "measured", "repair_request", "guarded_repair", "full"]);
    expect(result.comparison.modes.find((mode) => mode.mode === "advisory")?.summary.beads).toBe(0);
    expect(result.comparison.modes.find((mode) => mode.mode === "measured")?.summary.beads).toBeGreaterThan(0);
    expect(result.comparison.modes.find((mode) => mode.mode === "repair_request")?.summary.repairWorkOrders).toBeGreaterThan(0);
    expect(result.comparison.modes.find((mode) => mode.mode === "guarded_repair")).toMatchObject({
      status: "blocked",
      policy: {
        trustedWorkflowRequired: true
      }
    });
    expect(result.comparison.modes.find((mode) => mode.mode === "guarded_repair")?.blockedReasons).toEqual(
      expect.arrayContaining(["Guarded Hive repair requires integrations.hive.repair.enabled=true.", "Guarded Hive repair requires ACMM level 5 or higher."])
    );
    expect(result.comparison.modes.find((mode) => mode.mode === "full")).toMatchObject({
      status: "blocked",
      policy: {
        trustedWorkflowRequired: true
      }
    });
    expect(result.comparison.recommendation.mode).toBe("repair_request");
    expect(result.markdown).toContain("Hive Export Mode Comparison");
    expect(JSON.stringify(result.comparison)).not.toContain("secret-value");
  });

  it("matches the tracked Hive mode comparison JSON schema", async () => {
    const result = buildHiveModeComparison({
      evidencePacket: sampleEvidencePacket(),
      evidencePacketPath: ".visual-hive/evidence-packet.json",
      hiveConfig: { enabled: true },
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    const schema = JSON.parse(await readFile(path.join(repoRoot, "schemas", "visual-hive.hive-mode-comparison.schema.json"), "utf8")) as Record<string, unknown>;
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    expect(validate(result.comparison), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

function nodeIds(result: ReturnType<typeof buildHiveExportArtifacts>): Set<string> {
  return new Set(result.bundle.knowledgeGraph.nodes.map((node) => node.id));
}

function expectCatalogOutputResource(outputResource: {
  artifactKey: string;
  artifactPath: string;
  evidenceResourceId: string;
  evidenceResourceUri: string;
  evidenceResourceTitle: string;
  evidenceResourceDescription: string;
  evidenceReadToolName?: string;
}, artifactKey: string, artifactPath: string, resourceId: string): void {
  const resource = VISUAL_HIVE_EVIDENCE_RESOURCES.find((candidate) => candidate.id === resourceId);
  expect(resource, `Missing evidence resource ${resourceId}`).toBeDefined();
  expect(outputResource).toEqual({
    artifactKey,
    artifactPath,
    evidenceResourceId: resource!.id,
    evidenceResourceUri: resource!.uri,
    evidenceResourceTitle: resource!.title,
    evidenceResourceDescription: resource!.description,
    evidenceReadToolName: resource!.readTool?.name
  });
}

function sampleEvidencePacket(): EvidencePacket {
  return {
    schemaVersion: "visual-hive.evidence-packet.v2",
    generatedAt: "2026-07-02T00:00:00.000Z",
    project: "hive-export-fixture",
    sourceArtifacts: {
      report: ".visual-hive/report.json",
      mutationReport: ".visual-hive/mutation-report.json"
    },
    governance: {
      verdictAuthority: "visual_hive",
      defaultBrowserBackend: "playwright",
      llmAuthority: "advisory_only",
      providerAuthority: "policy_gated_when_normalized",
      secretPolicy: "redacted_values_names_only"
    },
    repo: {
      repository: "visual-hive/test",
      branch: "main",
      commitSha: "abcdef"
    },
    plan: {
      schemaVersion: 1,
      project: "hive-export-fixture",
      mode: "pr",
      generatedAt: "2026-07-02T00:00:00.000Z",
      changedFiles: ["src/App.tsx"],
      effectiveChangedFiles: ["src/App.tsx"],
      selectedContracts: ["hosted-demo-never-login"],
      selectedTargets: ["hostedDemo"],
      excludedContracts: []
    },
    deterministicReport: {
      schemaVersion: 2,
      project: "hive-export-fixture",
      mode: "pr",
      generatedAt: "2026-07-02T00:00:00.000Z",
      status: "failed",
      selectedTargets: [{ id: "hostedDemo", kind: "url", url: "https://console.example.invalid?token=secret-value", prSafe: true, cost: "cheap" }],
      selectedContracts: ["hosted-demo-never-login"],
      excludedContracts: [],
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
      generatedSpecPath: ".visual-hive/generated/visual-hive.generated.spec.ts",
      reproductionCommands: ["visual-hive run --ci"],
      failedContracts: [
        {
          contractId: "hosted-demo-never-login",
          targetId: "hostedDemo",
          errors: ["Unexpected login button access_token=secret-value"],
          artifacts: [".visual-hive/artifacts/screenshots/dashboard.png"],
          reproductionCommand: "visual-hive run --ci"
        }
      ],
      screenshotEvidence: [
        {
          contractId: "hosted-demo-never-login",
          screenshotName: "dashboard",
          status: "failed",
          route: "/",
          viewport: "desktop",
          baselinePath: ".visual-hive/snapshots/dashboard.png",
          actualPath: ".visual-hive/artifacts/screenshots/dashboard.png",
          diffPath: ".visual-hive/artifacts/screenshots/dashboard-diff.png",
          actualDiffPixelRatio: 0.2,
          actualDiffPixels: 200
        }
      ],
      consoleErrors: 0,
      pageErrors: 0,
      networkErrors: 0
    },
    mutation: {
      schemaVersion: 2,
      project: "hive-export-fixture",
      generatedAt: "2026-07-02T00:00:00.000Z",
      minScore: 0.75,
      score: 0.5,
      killed: 1,
      total: 2,
      survivedOperators: [
        {
          operator: "force-login-on-demo",
          contractIds: ["hosted-demo-never-login"],
          failedAssertion: "Mutation survived",
          artifacts: [".visual-hive/mutation-report.json"]
        }
      ],
      notApplicableOperators: []
    },
    providers: [
      {
        providerId: "argos",
        label: "Argos",
        status: "failed",
        deterministicRole: "supplemental",
        message: "Argos upload failed but remains advisory unless trusted gating is enabled.",
        requiredEnv: ["ARGOS_TOKEN"],
        missingEnv: [],
        artifactCount: 2,
        upload: {
          status: "failed",
          externalCallsMade: 1,
          uploadedArtifacts: 0,
          stagedArtifacts: 2,
          manifestPath: ".visual-hive/provider-upload/argos/manifest.json",
          uploadDirectory: ".visual-hive/provider-upload/argos",
          providerUrl: "https://app.argos-ci.com/build?token=secret-value",
          blockedReasons: ["authorization: Bearer secret-value"]
        }
      }
    ],
    testingLayers: [
      { id: 6, name: "E2E user-flow", status: "covered", evidence: [".visual-hive/report.json"], gaps: [] },
      { id: 9, name: "Mutation/fault injection", status: "covered", evidence: [".visual-hive/mutation-report.json"], gaps: [] },
      { id: 11, name: "Agent/Hive feedback", status: "partial", evidence: [".visual-hive/triage.json"], gaps: ["No Hive export yet."] }
    ],
    evidenceContributions: [
      {
        key: "playwright.selector_contract.hosted-demo-never-login",
        source: "playwright",
        kind: "selector_contract",
        status: "failed",
        gating: true,
        authority: "gating",
        mode: "pr",
        contractId: "hosted-demo-never-login",
        targetId: "hostedDemo",
        reason: "Unexpected login button access_token=secret-value",
        artifacts: [".visual-hive/artifacts/screenshots/dashboard.png"]
      },
      {
        key: "mutation.mutation_survivor.force-login-on-demo",
        source: "mutation",
        kind: "mutation_survivor",
        status: "warning",
        gating: false,
        authority: "advisory",
        operator: "force-login-on-demo",
        reason: "Mutation survived bearer secret-value",
        artifacts: [".visual-hive/mutation-report.json"]
      },
      {
        key: "provider.provider_upload.argos",
        source: "provider",
        kind: "provider_upload",
        status: "blocked",
        gating: false,
        authority: "advisory",
        providerId: "argos",
        reason: "Argos upload failed but provider evidence is advisory by default.",
        artifacts: [".visual-hive/provider-upload/argos/manifest.json"]
      }
    ],
    verdictSummary: {
      visualHiveVerdict: "failed",
      failedBecause: ["playwright.selector_contract.hosted-demo-never-login"],
      warningBecause: [],
      blockedBecause: [],
      advisoryOnly: ["mutation.mutation_survivor.force-login-on-demo", "provider.provider_upload.argos"]
    },
    hiveReadiness: {
      readyForIssueHandoff: true,
      readyForHiveDryRun: true,
      blockedReasons: [],
      suggestedLabels: ["visual-hive", "hive/quality", "ai-ready"],
      recommendedMode: "repair_request",
      recommendationReason: "Repair-request mode can package deterministic evidence into bounded work orders without granting Hive verdict authority.",
      modeReadiness: sampleHiveModeReadiness()
    }
  };
}

function sampleHiveModeReadiness(): EvidencePacket["hiveReadiness"]["modeReadiness"] {
  return [
    {
      mode: "advisory",
      status: "ready",
      reason: "Advisory mode can package sanitized issue context and policy only.",
      nextCommand: "visual-hive hive export --dry-run --mode advisory",
      localPreviewAllowed: true,
      trustedWorkflowRequired: false,
      externalCallsMade: 0,
      emits: { issueContext: true, beads: false, knowledgeFacts: false, knowledgeGraph: false, wikiVault: false, repairWorkOrders: false, agentPolicy: true },
      blockedReasons: []
    },
    {
      mode: "measured",
      status: "ready",
      reason: "Measured mode can add Beads, knowledge facts, graph context, and wiki pages.",
      nextCommand: "visual-hive hive export --dry-run --mode measured",
      localPreviewAllowed: true,
      trustedWorkflowRequired: false,
      externalCallsMade: 0,
      emits: { issueContext: true, beads: true, knowledgeFacts: true, knowledgeGraph: true, wikiVault: true, repairWorkOrders: false, agentPolicy: true },
      blockedReasons: []
    },
    {
      mode: "repair_request",
      status: "ready",
      reason: "Repair-request mode can emit bounded repair work orders for a trusted lane.",
      nextCommand: "visual-hive hive export --dry-run --mode repair_request",
      localPreviewAllowed: true,
      trustedWorkflowRequired: false,
      externalCallsMade: 0,
      emits: { issueContext: true, beads: true, knowledgeFacts: true, knowledgeGraph: true, wikiVault: true, repairWorkOrders: true, agentPolicy: true },
      blockedReasons: []
    },
    {
      mode: "guarded_repair",
      status: "blocked",
      reason: "guarded_repair is blocked by missing evidence or governance policy.",
      nextCommand: "visual-hive hive compare-modes",
      localPreviewAllowed: false,
      trustedWorkflowRequired: true,
      externalCallsMade: 0,
      emits: { issueContext: true, beads: true, knowledgeFacts: true, knowledgeGraph: true, wikiVault: true, repairWorkOrders: true, agentPolicy: true },
      blockedReasons: ["Guarded Hive repair requires integrations.hive.repair.enabled=true."]
    },
    {
      mode: "full",
      status: "blocked",
      reason: "full is blocked by missing evidence or governance policy.",
      nextCommand: "visual-hive hive compare-modes",
      localPreviewAllowed: false,
      trustedWorkflowRequired: true,
      externalCallsMade: 0,
      emits: { issueContext: true, beads: true, knowledgeFacts: true, knowledgeGraph: true, wikiVault: true, repairWorkOrders: true, agentPolicy: true },
      blockedReasons: ["Full Hive automation is reserved for a future ACMM L6-compatible workflow and is blocked locally."]
    }
  ];
}
