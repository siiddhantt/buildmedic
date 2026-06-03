import path from "node:path";
import {
  getPullFiles,
  getPullRequest,
  readPullFile,
  type PullRequestSummary,
} from "./coral-github";
import { parsePatchProposal } from "./json";
import {
  loadGitAgentModule,
  hasProviderKey,
  defaultModel,
  summarizeToolResult,
  safeToolResult,
  type GitAgentModule,
} from "./gitagent";
import type { PullRequestRef } from "./pr-url";
import type { TriageReport, PatchProposal, TimelineEvent } from "./types";

export type PatchEvent =
  | { type: "status"; message: string }
  | { type: "tool"; name: string; args: unknown }
  | { type: "tool_result"; message: string }
  | { type: "timeline"; item: TimelineEvent }
  | { type: "error"; message: string };

type PatchOptions = {
  onEvent?: (event: PatchEvent) => void;
};

export async function runPatchAgent(
  triage: TriageReport,
  ref: PullRequestRef,
  options: PatchOptions = {},
): Promise<PatchProposal | null> {
  if (!hasProviderKey()) return null;

  const mod = await loadGitAgentModule();
  const timeline: TimelineEvent[] = [];
  const state: { pull?: PullRequestSummary } = {};
  const tools = buildPatchTools(mod, ref, state);
  let finalText = "";
  const emit = options.onEvent ?? (() => undefined);

  emit({ type: "status", message: "Starting Patch Agent." });

  for await (const message of mod.query({
    dir: path.join(process.cwd(), "agent", "patch"),
    prompt: buildPatchPrompt(triage),
    model: process.env.BUILDMEDIC_MODEL ?? defaultModel(),
    tools,
    replaceBuiltinTools: true,
    maxTurns: 16,
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

  const proposal = parsePatchProposal(finalText);
  if (!proposal) {
    emit({
      type: "error",
      message:
        "Patch Agent did not return a parseable patch proposal. It may have exhausted its turn budget while gathering context.",
    });
  }
  if (!proposal) return null;

  return {
    ...proposal,
    timeline: [
      {
        label: "Patch Agent started",
        detail: "Drafting a proposed diff based on triage diagnosis.",
      },
      ...timeline,
      ...proposal.timeline,
    ],
  };
}

function buildPatchTools(
  mod: GitAgentModule,
  ref: PullRequestRef,
  state: { pull?: PullRequestSummary },
) {
  return [
    mod.tool(
      "get_pull_files",
      "Fetch changed PR files and patches through Coral GitHub SQL.",
      { properties: { limit: { type: "number" } } },
      async (args) =>
        safeToolResult("get_pull_files", async () => ({
          text: JSON.stringify(
            await getPullFiles(ref, Number(args.limit ?? 80)),
          ),
        })),
    ),
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

function buildPatchPrompt(triage: TriageReport): string {
  return `You are BuildMedic Patch Agent. Your job is to generate a minimal proposed patch for the CI failure diagnosed below.

## Triage Diagnosis

Summary: ${triage.summary}
Root Cause: ${triage.rootCause}
Failure Type: ${triage.failureType}
Confidence: ${triage.confidence}

### Evidence
${triage.evidence.map((e) => `- [${e.source}] ${e.detail}`).join("\n")}

### Suspected Files
${triage.suspectedFiles.map((f) => `- ${f}`).join("\n")}

### Patch Plan
${triage.patchPlan.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Instructions

1. Call get_pull_files first to inspect changed file patches.
2. Read only the most relevant suspected files needed to make the diff precise.
3. If read_pr_file returns unavailable for a file, use get_pull_files patch context and the triage evidence instead of stopping.
4. Generate a minimal unified diff that fixes the root cause.
5. Only modify what is necessary — no refactoring, no style changes.
6. The diff must be valid unified diff format with proper file headers.
7. Prefer producing patch_ready with caveats over cannot_patch when the root cause and target file are clear.

Return only valid JSON matching this shape:
{
  "status": "patch_ready" | "cannot_patch",
  "summary": string,
  "diff": string,
  "explanation": string,
  "filesModified": string[],
  "confidence": "low" | "medium" | "high",
  "caveats": string[],
  "timeline": [{"label": string, "detail": string}]
}

Rules:
- Always ground the diff in either read_pr_file content or get_pull_files patch context.
- Minimal changes only — fix the diagnosed issue, nothing else.
- If you cannot produce a reliable proposal, set status to "cannot_patch" with an explanation.
- The diff field must contain a valid unified diff or be empty if cannot_patch.
- This stage proposes changes only. It never writes files, opens PRs, installs packages, pushes, deploys, or performs destructive actions.
- If a tool returns unavailable data, explain the limitation and lower confidence instead of inventing file contents.`;
}
