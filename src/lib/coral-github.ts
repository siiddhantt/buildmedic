import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PullRequestRef } from "./pr-url";
import { splitFullName } from "./pr-url";

const exec = promisify(execFile);
const maxBuffer = 8 * 1024 * 1024;

export type PullRequestSummary = {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  body: string | null;
  html_url: string;
  head__sha: string;
  head__ref: string;
  head__repo__full_name: string | null;
  base__ref: string;
  user__login: string | null;
  changed_files: number | null;
  additions: number | null;
  deletions: number | null;
};

export async function getPullRequest(ref: PullRequestRef) {
  return first<PullRequestSummary>(`
    select number, title, state, draft, body, html_url, head__sha, head__ref,
           head__repo__full_name, base__ref, user__login, changed_files, additions, deletions
    from github.pulls
    where owner = ${literal(ref.owner)} and repo = ${literal(ref.repo)} and pull_number = ${ref.pullNumber}
    limit 1
  `);
}

export async function getPullFiles(ref: PullRequestRef, limit = 80) {
  return coralSql(`
    select filename, status, additions, deletions, changes, patch, raw_url
    from github.files
    where owner = ${literal(ref.owner)} and repo = ${literal(ref.repo)} and pull_number = ${ref.pullNumber}
    limit ${boundedLimit(limit, 120)}
  `);
}

export async function getWorkflowRuns(
  ref: PullRequestRef,
  headSha: string,
  limit = 20,
) {
  return coralSql(`
    select id, name, display_title, status, conclusion, event, head_branch, head_sha,
           html_url, created_at, updated_at, run_attempt, jobs_url, logs_url
    from github.repo_action_runs
    where owner = ${literal(ref.owner)} and repo = ${literal(ref.repo)} and head_sha = ${literal(headSha)}
    limit ${boundedLimit(limit, 50)}
  `);
}

export async function getWorkflowJobs(
  ref: PullRequestRef,
  runId: number,
  limit = 80,
) {
  return coralSql(`
    select id, name, status, conclusion, started_at, completed_at, html_url, run_id,
           run_attempt, check_run_url, steps
    from github.jobs
    where owner = ${literal(ref.owner)} and repo = ${literal(ref.repo)} and run_id = ${Number(runId)}
    limit ${boundedLimit(limit, 120)}
  `);
}

export async function getCheckAnnotations(
  ref: PullRequestRef,
  checkRunId: number,
  limit = 80,
) {
  return coralSql(`
    select path, start_line, end_line, annotation_level, message, raw_details, title
    from github.annotations
    where owner = ${literal(ref.owner)} and repo = ${literal(ref.repo)} and check_run_id = ${Number(checkRunId)}
    limit ${boundedLimit(limit, 120)}
  `);
}

export async function readPullFile(
  ref: PullRequestRef,
  pull: PullRequestSummary,
  filePath: string,
  maxChars = 30000,
) {
  const headRepo = splitFullName(pull.head__repo__full_name ?? undefined, ref);
  const limit = Math.max(1000, Math.min(maxChars, 60000));
  const rows = await coralSql<{
    content_text?: string;
    size?: number;
    type?: string;
  }>(
    `
      select content_text, size, type
      from github.contents
      where owner = ${literal(headRepo.owner)}
        and repo = ${literal(headRepo.repo)}
        and path = ${literal(filePath)}
        and ref = ${literal(pull.head__sha)}
      limit 1
    `,
  ).catch(() => []);

  const content = rows[0]?.content_text;
  if (content) return { text: content.slice(0, limit) };

  const fallback = await readGitHubFile(
    headRepo.owner,
    headRepo.repo,
    filePath,
    pull.head__sha,
    limit,
  );
  if (fallback) return { text: fallback };

  return {
    text: `File content unavailable or file is not text at ${headRepo.owner}/${headRepo.repo}@${pull.head__sha}:${filePath}.`,
  };
}

async function first<T>(sql: string): Promise<T> {
  const rows = await coralSql<T>(sql);
  if (!rows[0])
    throw new Error("No matching GitHub record found through Coral.");
  return rows[0];
}

async function coralSql<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const { stdout } = await exec(
    "coral",
    ["sql", "--format", "json", compact(sql)],
    { maxBuffer },
  );
  return JSON.parse(stdout) as T[];
}

async function readGitHubFile(
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
  maxChars: number,
) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(await authHeader()),
      },
    },
  );

  if (!response.ok) return null;

  const payload = (await response.json()) as {
    type?: string;
    content?: string;
    encoding?: string;
  };

  if (
    payload.type !== "file" ||
    payload.encoding !== "base64" ||
    !payload.content
  )
    return null;

  return Buffer.from(payload.content.replace(/\s/g, ""), "base64")
    .toString("utf-8")
    .slice(0, maxChars);
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await githubToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  try {
    const { stdout } = await exec("gh", ["auth", "token"], {
      maxBuffer: 128 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function compact(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

function encodePath(value: string) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function boundedLimit(value: number, max: number) {
  const limit = Number.isFinite(value) ? Math.trunc(value) : 20;
  return Math.max(1, Math.min(limit, max));
}
