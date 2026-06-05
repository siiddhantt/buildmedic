# BuildMedic

A GitAgent-powered CI failure assistant for GitHub pull requests.

<img width="1440" height="780" alt="BuildMedic workflow screenshot" src="https://github.com/user-attachments/assets/32a9ebd5-0c42-42be-8c0a-9057e39fc3e6" />

BuildMedic turns a failing pull request into a reviewed, approval-ready engineering decision:

- evidence-backed CI failure summary
- likely root cause and uncertainty
- relevant logs, jobs, PR metadata, and files
- patch or no-patch decision
- independent review verdict
- persisted local run history

The proof of concept is intentionally read-only. Agents investigate and propose, but they do not push branches, edit PRs, retry workflows, or mutate repository state.

## Why

CI failures are repetitive engineering work. Developers often spend the first 10-20 minutes opening a PR, finding failed runs, reading noisy logs, mapping errors back to files, and deciding whether the fix is code, dependency, CI configuration, metadata, or infrastructure.

BuildMedic compresses that first pass into an auditable multi-agent workflow.

## Workflow

BuildMedic uses three GitAgent-defined agents:

- **Triage Agent** diagnoses the failure with evidence from PR metadata, changed files, workflow runs, jobs, annotations, and logs.
- **Patch Agent** proposes a minimal unified diff when code should change, or returns a no-patch decision when the right fix is outside source code.
- **Review Agent** validates both proposed patches and no-patch decisions before the output is trusted.

Every stage, tool call, final artifact, and review verdict is streamed to the UI and persisted in SQLite.

## GitAgent Alignment

BuildMedic uses GitAgent as the agent definition and runtime layer:

- versioned agent identity in `agent.yaml`
- role and behavioral constraints in `SOUL.md` and `RULES.md`
- composable behavior in `skills/*/SKILL.md`
- SDK `query()` streaming for agent events
- custom read-only tools injected into each agent
- `preToolUse` hooks for explicit tool gating

The Next.js app orchestrates the product workflow around these GitAgent agents.

## Stack

- Next.js
- TypeScript
- GitAgent SDK
- Coral GitHub source
- SQLite
- GitHub Actions log downloader

## Data And Safety

Coral is the primary structured GitHub data plane for pull requests, changed files, workflow runs, jobs, annotations, and contents.

GitHub Actions logs are downloaded directly because GitHub serves job logs as redirected text instead of ordinary JSON rows.

SQLite stores the local audit ledger at `.buildmedic/buildmedic.sqlite` by default. GitAgent memory remains curated agent state; runtime history belongs in SQLite so saved runs can be reloaded or deleted without dirtying agent definitions.

## Run Locally

```bash
npm install
npm run dev
```

Set at least one model provider key before running GitAgent mode:

```bash
export OPENROUTER_API_KEY=...
export BUILDMEDIC_MODEL=openrouter:deepseek/deepseek-v4-flash
```

For private repository logs, also expose a GitHub token or authenticate GitHub CLI:

```bash
export GITHUB_TOKEN=...
# or
gh auth login
```

Open `http://localhost:3000`.

`BUILDMEDIC_MODEL` is optional when using OpenRouter. The default is `openrouter:deepseek/deepseek-v4-flash`.

Override the local database path with:

```bash
export BUILDMEDIC_DB_PATH=/path/to/buildmedic.sqlite
```

## Demo Path

1. Paste a failing GitHub pull request URL.
2. Watch the live GitAgent tool stream.
3. Review the triage report and evidence.
4. Inspect the patch or no-patch decision.
5. Check the independent review verdict.
6. Reload or delete saved runs from local history.

## Enterprise Path

The current version is read-only by design. A production write path would add explicit human approval, branch isolation, policy checks, and a gated GitHub connector before opening or updating pull requests.
