import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PullRequestRef } from "./pr-url";

const exec = promisify(execFile);

export async function downloadJobLog(
  ref: PullRequestRef,
  jobId: number,
  maxChars = 60000,
) {
  const token = await githubToken();
  const response = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/actions/jobs/${jobId}/logs`,
    {
      headers: token
        ? {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          }
        : {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub job log download failed with HTTP ${response.status}. Set GITHUB_TOKEN or run gh auth login for private repos.`,
    );
  }

  const text = await response.text();
  return { text: text.slice(0, Math.max(4000, Math.min(maxChars, 120000))) };
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
