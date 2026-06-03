import { z } from "zod";

export const TriageRequestSchema = z.object({
  prUrl: z.string().url(),
});

export const EvidenceSchema = z.object({
  source: z.string(),
  detail: z.string(),
});

export const TriageReportSchema = z.object({
  engine: z.enum(["gitagent", "local"]),
  status: z.enum(["triaged", "needs_more_context"]),
  summary: z.string(),
  reportMarkdown: z.string().optional().default(""),
  rootCause: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  failureType: z.enum([
    "test",
    "typecheck",
    "lint",
    "dependency",
    "build",
    "ci_config",
    "environment",
    "unknown",
  ]),
  evidence: z.array(EvidenceSchema),
  suspectedFiles: z.array(z.string()),
  patchPlan: z.array(z.string()),
  safeCommands: z.array(z.string()),
  approvalRequired: z.boolean(),
  timeline: z.array(z.object({ label: z.string(), detail: z.string() })),
});

export const PatchProposalSchema = z.object({
  status: z.enum(["patch_ready", "cannot_patch"]),
  summary: z.string(),
  diff: z.string(),
  explanation: z.string(),
  filesModified: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
  caveats: z.array(z.string()),
  timeline: z.array(z.object({ label: z.string(), detail: z.string() })),
});

export const ReviewVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject", "needs_changes"]),
  summary: z.string(),
  concerns: z.array(
    z.object({
      severity: z.enum(["low", "medium", "high", "critical"]),
      description: z.string(),
    }),
  ),
  recommendation: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  timeline: z.array(z.object({ label: z.string(), detail: z.string() })),
});

export const PipelineResultSchema = z.object({
  triage: TriageReportSchema,
  patch: PatchProposalSchema.optional(),
  review: ReviewVerdictSchema.optional(),
  pipelineStage: z.enum([
    "triage",
    "patching",
    "reviewing",
    "complete",
    "failed",
  ]),
});

export type TriageRequest = z.infer<typeof TriageRequestSchema>;
export type TriageReport = z.infer<typeof TriageReportSchema>;
export type TimelineEvent = TriageReport["timeline"][number];
export type PatchProposal = z.infer<typeof PatchProposalSchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type PipelineResult = z.infer<typeof PipelineResultSchema>;
