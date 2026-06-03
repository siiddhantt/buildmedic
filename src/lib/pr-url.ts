export type PullRequestRef = {
  owner: string;
  repo: string;
  pullNumber: number;
};

const safeSlug = /^[A-Za-z0-9_.-]+$/;

export function parsePullRequestUrl(value: string): PullRequestRef {
  const url = new URL(value);
  const [owner, repo, segment, number] = url.pathname
    .split("/")
    .filter(Boolean);
  const pullNumber = Number(number);

  if (
    url.hostname !== "github.com" ||
    segment !== "pull" ||
    !owner ||
    !repo ||
    !Number.isInteger(pullNumber)
  ) {
    throw new Error(
      "Enter a GitHub pull request URL like https://github.com/owner/repo/pull/123.",
    );
  }

  if (!safeSlug.test(owner) || !safeSlug.test(repo) || pullNumber <= 0) {
    throw new Error(
      "GitHub pull request URL contains unsupported owner, repo, or PR number.",
    );
  }

  return { owner, repo, pullNumber };
}

export function splitFullName(
  fullName: string | undefined,
  fallback: Pick<PullRequestRef, "owner" | "repo">,
) {
  const [owner, repo] = String(fullName ?? "").split("/");
  if (owner && repo && safeSlug.test(owner) && safeSlug.test(repo))
    return { owner, repo };
  return fallback;
}
