import path from "node:path";
import {
  getCheckAnnotations,
  getPullFiles,
  getPullRequest,
  getWorkflowJobs,
  getWorkflowRuns,
  readPullFile,
  type PullRequestSummary,
} from "./coral-github";
import { downloadJobLog } from "./github-logs";
import { parseAgentReport } from "./json";
import type { PullRequestRef } from "./pr-url";
import type { TriageReport, TimelineEvent } from "./types";

export type GitAgentModule = {
  query: (
    options: Record<string, unknown>,
  ) => AsyncGenerator<Record<string, unknown>>;
  tool: (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ) => unknown;
};

export async function loadGitAgentModule(): Promise<GitAgentModule> {
  return (await import("@open-gitagent/gitagent")) as unknown as GitAgentModule;
}

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "tool"; name: string; args: unknown }
  | { type: "tool_result"; message: string }
  | { type: "timeline"; item: TimelineEvent }
  | { type: "final"; report: TriageReport }
  | { type: "error"; message: string };

type TriageOptions = {
  onEvent?: (event: AgentEvent) => void;
};

export async function runGitAgentTriage(
  prUrl: string,
  ref: PullRequestRef,
  options: TriageOptions = {},
): Promise<TriageReport | null> {
  if (!hasProviderKey()) return null;

  const mod = await loadGitAgentModule();
  const timeline: TimelineEvent[] = [];
  const state: { pull?: PullRequestSummary } = {};
  const tools = buildTools(mod, ref, state, timeline);
  let finalText = "";
  const emit = options.onEvent ?? (() => undefined);

  emit({
    type: "status",
    message: "Starting GitAgent with Coral-backed GitHub tools.",
  });

  for await (const message of mod.query({
    dir: path.join(process.cwd(), "agent", "triage"),
    prompt: buildPrompt(prUrl),
    model: process.env.BUILDMEDIC_MODEL ?? defaultModel(),
    tools,
    replaceBuiltinTools: true,
    maxTurns: 14,
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
      emit({ type: "timeline", item });
    }

    if (type === "assistant") {
      finalText = String(message.content ?? "");
    }
  }

  const report = parseAgentReport(finalText);
  if (!report) return null;

  const finalReport: TriageReport = {
    ...report,
    engine: "gitagent",
    approvalRequired: true,
    timeline: [
      {
        label: "GitAgent started",
        detail: "PR URL mode with Coral-backed GitHub tools.",
      },
      ...timeline,
      ...report.timeline,
      {
        label: "Write gate",
        detail:
          "Diagnosis generated. No files, PRs, or workflow state changed.",
      },
    ],
  };
  emit({ type: "final", report: finalReport });
  return finalReport;
}

function buildTools(
  mod: GitAgentModule,
  ref: PullRequestRef,
  state: { pull?: PullRequestSummary },
  timeline: TimelineEvent[],
) {
  return [
    mod.tool(
      "get_pull_request",
      "Fetch pull request metadata through Coral GitHub SQL.",
      {},
      async () => {
        const pull = await getPullRequest(ref);
        state.pull = pull;
        timeline.push({
          label: "PR loaded",
          detail: `${ref.owner}/${ref.repo}#${ref.pullNumber} at ${pull.head__sha}`,
        });
        return { text: JSON.stringify(pull) };
      },
    ),
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
      "get_repository_guidance",
      "Read common repository guidance files at the PR head SHA.",
      {},
      async () => {
        return safeToolResult("get_repository_guidance", async () => {
          const pull = state.pull ?? (await getPullRequest(ref));
          state.pull = pull;
          const paths = [
            "AGENTS.md",
            ".github/AGENTS.md",
            "CONTRIBUTING.md",
            ".github/CONTRIBUTING.md",
            "README.md",
          ];
          const results = [];

          for (const filePath of paths) {
            const result = await readPullFile(
              ref,
              pull,
              filePath,
              filePath === "README.md" ? 6000 : 18000,
            );
            if (!result.text.startsWith("File content unavailable"))
              results.push({ path: filePath, text: result.text });
          }

          return { text: JSON.stringify(results) };
        });
      },
    ),
    mod.tool(
      "get_workflow_runs",
      "Fetch GitHub Actions workflow runs for the PR head SHA through Coral GitHub SQL.",
      { properties: { limit: { type: "number" } } },
      async (args) => {
        return safeToolResult("get_workflow_runs", async () => {
          const pull = state.pull ?? (await getPullRequest(ref));
          state.pull = pull;
          const runs = await getWorkflowRuns(
            ref,
            pull.head__sha,
            Number(args.limit ?? 20),
          );
          return { text: JSON.stringify(runs) };
        });
      },
    ),
    mod.tool(
      "get_workflow_jobs",
      "Fetch jobs for one workflow run through Coral GitHub SQL.",
      {
        properties: {
          run_id: { type: "number" },
          limit: { type: "number" },
        },
        required: ["run_id"],
      },
      async (args) =>
        safeToolResult("get_workflow_jobs", async () => ({
          text: JSON.stringify(
            await getWorkflowJobs(
              ref,
              Number(args.run_id),
              Number(args.limit ?? 80),
            ),
          ),
        })),
    ),
    mod.tool(
      "download_job_log",
      "Download raw text logs for one GitHub Actions job.",
      {
        properties: {
          job_id: { type: "number" },
          max_chars: { type: "number" },
        },
        required: ["job_id"],
      },
      async (args) =>
        safeToolResult("download_job_log", () =>
          downloadJobLog(
            ref,
            Number(args.job_id),
            Number(args.max_chars ?? 60000),
          ),
        ),
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
    mod.tool(
      "get_check_annotations",
      "Fetch check run annotations through Coral GitHub SQL when a check_run_id is known.",
      {
        properties: {
          check_run_id: { type: "number" },
          limit: { type: "number" },
        },
        required: ["check_run_id"],
      },
      async (args) =>
        safeToolResult("get_check_annotations", async () => ({
          text: JSON.stringify(
            await getCheckAnnotations(
              ref,
              Number(args.check_run_id),
              Number(args.limit ?? 80),
            ),
          ),
        })),
    ),
  ];
}

function buildPrompt(prUrl: string) {
  return `
You are BuildMedic. Triage the failing CI for this GitHub pull request using only the provided read-only tools.

Pull request URL:
${prUrl}

Suggested workflow:
1. Call get_pull_request.
2. Call get_pull_files.
3. Call get_workflow_runs and identify failed or cancelled runs for the PR head SHA.
4. Call get_workflow_jobs for the most relevant failed run.
5. Download only the most relevant failed job log.
6. Read PR files only when the log or patch points to them.

Return only valid JSON matching this TypeScript shape:
{
  "engine": "gitagent",
  "status": "triaged" | "needs_more_context",
  "summary": string,
  "reportMarkdown": string,
  "rootCause": string,
  "confidence": "low" | "medium" | "high",
  "failureType": "test" | "typecheck" | "lint" | "dependency" | "build" | "ci_config" | "environment" | "unknown",
  "evidence": [{"source": string, "detail": string}],
  "suspectedFiles": string[],
  "patchPlan": string[],
  "safeCommands": string[],
  "approvalRequired": true,
  "timeline": [{"label": string, "detail": string}]
}

Rules:
- Do not invent files, commands, logs, or CI jobs.
- Prefer one likely root cause.
- Cite exact log evidence and PR file evidence.
- Call get_repository_guidance before declaring a workflow condition, CI trigger, or repo policy wrong.
- Distinguish "confirmed by logs" from "inferred from job metadata or annotations".
- If raw job logs are inaccessible, do not guess the exact npm/test/build failure. Say the exact low-level failure is unknown and lower confidence unless annotations prove it.
- No write, install, push, deploy, retry, rerun, or destructive action is allowed.
- If no failed CI run or logs are accessible, return status "needs_more_context" and explain the missing access.
- reportMarkdown should be a concise markdown report with headings for Diagnosis, Evidence, Uncertainty, and Next Step.
`;
}

export function hasProviderKey() {
  return Boolean(
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.DEEPSEEK_API_KEY,
  );
}

export function defaultModel() {
  if (process.env.OPENROUTER_API_KEY)
    return "openrouter:deepseek/deepseek-v4-flash";
  if (process.env.DEEPSEEK_API_KEY) return "deepseek:deepseek-v4-flash";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic:claude-sonnet-4.5";
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY)
    return "google:gemini-2.5-flash";
  return "openai:gpt-4o-mini";
}

export function summarizeToolResult(content: string) {
  return content.replace(/\s+/g, " ").slice(0, 180);
}

export async function safeToolResult<T>(
  operation: string,
  run: () => Promise<T> | T,
): Promise<T | { text: string }> {
  try {
    return await run();
  } catch (error) {
    return {
      text: JSON.stringify({
        unavailable: true,
        operation,
        reason: toolFailureReason(error),
      }),
    };
  }
}

export function toolFailureReason(error: unknown) {
  if (!(error instanceof Error))
    return "The data source returned an unknown error.";

  if (error.message.includes("coral sql")) {
    return "Coral could not return the requested GitHub data. Treat this source as unavailable and lower confidence.";
  }

  return error.message.replace(/\s+/g, " ").slice(0, 300);
}

export function buildFileReadTools(
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
