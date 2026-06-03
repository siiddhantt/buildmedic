import path from "node:path";
import {
  getPullRequest,
  readPullFile,
  type PullRequestSummary,
} from "./coral-github";
import { parseReviewVerdict } from "./json";
import {
  loadGitAgentModule,
  hasProviderKey,
  defaultModel,
  summarizeToolResult,
  safeToolResult,
  type GitAgentModule,
} from "./gitagent";
import type { PullRequestRef } from "./pr-url";
import type {
  TriageReport,
  PatchProposal,
  ReviewVerdict,
  TimelineEvent,
} from "./types";

export type ReviewEvent =
  | { type: "status"; message: string }
  | { type: "tool"; name: string; args: unknown }
  | { type: "tool_result"; message: string }
  | { type: "timeline"; item: TimelineEvent }
  | { type: "error"; message: string };

type ReviewOptions = {
  onEvent?: (event: ReviewEvent) => void;
};

export async function runReviewAgent(
  triage: TriageReport,
  patch: PatchProposal,
  ref: PullRequestRef,
  options: ReviewOptions = {},
): Promise<ReviewVerdict | null> {
  if (!hasProviderKey()) return null;

  const mod = await loadGitAgentModule();
  const timeline: TimelineEvent[] = [];
  const state: { pull?: PullRequestSummary } = {};
  const tools = buildReviewTools(mod, ref, state);
  let finalText = "";
  const emit = options.onEvent ?? (() => undefined);

  emit({ type: "status", message: "Starting Review Agent." });

  for await (const message of mod.query({
    dir: path.join(process.cwd(), "agent", "review"),
    prompt: buildReviewPrompt(triage, patch),
    model: process.env.BUILDMEDIC_MODEL ?? defaultModel(),
    tools,
    replaceBuiltinTools: true,
    maxTurns: 8,
    hooks: {
      preToolUse: async () => ({ action: "allow" }),
    },
  })) {
    const type = String(message.type ?? "");

    if (type === "tool_use") {
      const name = String(message.toolName ?? "unknown");
      const item = {
        label: `Tool: ${name}`,
        detail: JSON.stringify(message.args ?? {}),
      };
      timeline.push(item);
      emit({ type: "tool", name, args: message.args ?? {} });
      emit({ type: "timeline", item });
    }

    if (type === "tool_result") {
      const detail = summarizeToolResult(String(message.content ?? ""));
      const item = { label: "Tool result", detail };
      timeline.push(item);
      emit({ type: "tool_result", message: detail });
    }

    if (type === "assistant") {
      finalText = String(message.content ?? "");
    }
  }

  const verdict = parseReviewVerdict(finalText);
  if (!verdict) return null;

  return {
    ...verdict,
    timeline: [
      {
        label: "Review Agent started",
        detail: "Reviewing patch against triage diagnosis.",
      },
      ...timeline,
      ...verdict.timeline,
    ],
  };
}

function buildReviewTools(
  mod: GitAgentModule,
  ref: PullRequestRef,
  state: { pull?: PullRequestSummary },
) {
  return [
    mod.tool(
      "read_pr_file",
      "Read a text file at the PR head SHA through Coral GitHub SQL.",
      {
        properties: {
          path: { type: "string" },
          max_chars: { type: "number" },
        },
        required: ["path"],
      },
      async (args) => {
        return safeToolResult("read_pr_file", async () => {
          const pull = state.pull ?? (await getPullRequest(ref));
          state.pull = pull;
          return readPullFile(
            ref,
            pull,
            String(args.path),
            Number(args.max_chars ?? 30000),
          );
        });
      },
    ),
  ];
}

function buildReviewPrompt(triage: TriageReport, patch: PatchProposal): string {
  return `You are BuildMedic Review Agent. Your job is to review the proposed patch against the triage diagnosis and verify correctness.

## Triage Diagnosis

Summary: ${triage.summary}
Root Cause: ${triage.rootCause}
Failure Type: ${triage.failureType}
Confidence: ${triage.confidence}

### Evidence
${triage.evidence.map((e) => `- [${e.source}] ${e.detail}`).join("\n")}

### Suspected Files
${triage.suspectedFiles.map((f) => `- ${f}`).join("\n")}

## Proposed Patch

Status: ${patch.status}
Summary: ${patch.summary}
Explanation: ${patch.explanation}
Files Modified: ${patch.filesModified.join(", ")}
Patch Confidence: ${patch.confidence}

### Diff
\`\`\`diff
${patch.diff}
\`\`\`

### Caveats
${patch.caveats.map((c) => `- ${c}`).join("\n")}

## Instructions

1. Read the modified files using read_pr_file to understand the full context.
2. Verify the patch addresses the diagnosed root cause.
3. Check for potential regressions, broken imports, type errors, or logic bugs.
4. Check for security issues introduced by the patch.
5. Assess whether the patch is minimal and appropriate.

Return only valid JSON matching this shape:
{
  "verdict": "approve" | "reject" | "needs_changes",
  "summary": string,
  "concerns": [{"severity": "low" | "medium" | "high" | "critical", "description": string}],
  "recommendation": string,
  "confidence": "low" | "medium" | "high",
  "timeline": [{"label": string, "detail": string}]
}

Rules:
- Be thorough but fair — minor style issues are not grounds for rejection.
- Reject if the patch could introduce regressions or does not address the root cause.
- Use "needs_changes" if the approach is correct but implementation needs adjustment.
- This stage reviews a proposed diff only. It never writes files, opens PRs, installs packages, pushes, deploys, or performs destructive actions.
- If a tool returns unavailable data, make the limitation explicit and lower confidence instead of assuming context.`;
}
