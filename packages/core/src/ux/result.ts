export type UxScoutResultStatus = "completed" | "skipped" | "failed";
export type UxScoutFindingSeverity = "low" | "medium" | "high" | "critical";
export type UxScoutFindingCategory = "usability" | "accessibility" | "interaction" | "recovery" | "feedback";

export interface UxScoutFinding {
  id: string;
  flowId: string;
  severity: UxScoutFindingSeverity;
  category: UxScoutFindingCategory;
  title: string;
  summary: string;
  recommendation: string;
  evidence: string[];
}

export interface UxScoutResult {
  schemaVersion: "visual-hive.ux-scout-result.v1";
  generatedAt: string;
  project: string;
  status: UxScoutResultStatus;
  advisoryOnly: true;
  sourceContext: string;
  affectedFlows: string[];
  findings: UxScoutFinding[];
  error?: string;
}
