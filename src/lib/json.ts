import {
  TriageReportSchema,
  PatchProposalSchema,
  ReviewVerdictSchema,
  type TriageReport,
  type PatchProposal,
  type ReviewVerdict,
} from "./types";

function extractCandidates(text: string): string[] {
  return [
    text,
    text.match(/```json\s*([\s\S]*?)```/i)?.[1],
    text.match(/\{[\s\S]*\}/)?.[0],
  ].filter(Boolean) as string[];
}

export function parseAgentReport(text: string): TriageReport | null {
  for (const candidate of extractCandidates(text)) {
    try {
      return TriageReportSchema.parse(JSON.parse(candidate));
    } catch {
      continue;
    }
  }
  return null;
}

export function parsePatchProposal(text: string): PatchProposal | null {
  for (const candidate of extractCandidates(text)) {
    try {
      return PatchProposalSchema.parse(JSON.parse(candidate));
    } catch {
      continue;
    }
  }
  return null;
}

export function parseReviewVerdict(text: string): ReviewVerdict | null {
  for (const candidate of extractCandidates(text)) {
    try {
      return ReviewVerdictSchema.parse(JSON.parse(candidate));
    } catch {
      continue;
    }
  }
  return null;
}
