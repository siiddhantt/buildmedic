# BuildMedic

BuildMedic is a GitAgent-powered CI failure triage assistant for GitHub pull requests.

It turns one failing pull request URL into:

- a concise failure summary
- likely root cause
- evidence from CI logs and PR files
- files to inspect
- approval-ready patch proposal
- independent review verdict
- persisted local run history

The proof of concept is intentionally scoped to one reliable workflow: read-only investigation first, human approval before any write path.

## Why this exists

CI failures are repetitive engineering work. Developers often spend the first 10-20 minutes opening a PR, finding the failed run, reading noisy logs, mapping the error back to files, and deciding whether the fix is code, dependency, test, or CI configuration.

BuildMedic compresses that first pass into an auditable agent workflow.

## Stack

- Next.js
- TypeScript
- GitAgent SDK
- Coral GitHub source for PR, workflow, job, and file data
- SQLite audit ledger
- A narrow GitHub Actions job log downloader

## Architecture

BuildMedic uses three GitAgent-defined agents:

- Triage Agent: diagnoses the failure with evidence.
- Proposal Agent: drafts a minimal unified diff without applying it.
- Review Agent: checks the proposed diff for correctness and safety.

Coral is the structured read-only GitHub data plane. SQLite persists runs, streamed events, tool calls, reports, evidence, patch proposals, and review verdicts locally.

See `docs/ARCHITECTURE.md` for the full workflow.

## Run

```bash
npm install
npm run dev
```

Set at least one model provider key before running GitAgent mode:

```bash
export OPENROUTER_API_KEY=...
export BUILDMEDIC_MODEL=openrouter:deepseek/deepseek-v4-flash
```

For private repository logs, also expose a GitHub token to the app or authenticate GitHub CLI:

```bash
export GITHUB_TOKEN=...
# or
gh auth login
```

Open `http://localhost:3000`.

`BUILDMEDIC_MODEL` is optional when using OpenRouter. The default is `openrouter:deepseek/deepseek-v4-flash`.

BuildMedic stores local run history at `.buildmedic/buildmedic.sqlite` by default. Override it with:

```bash
export BUILDMEDIC_DB_PATH=/path/to/buildmedic.sqlite
```

## Demo Path

1. Paste a failing GitHub pull request URL.
2. Run triage.
3. Review the live agent timeline, findings, failed job evidence, proposed diff, and review verdict.
4. Refresh or reload a recent run to show durable local audit history.
5. Explain that writes are intentionally approval-gated for the challenge demo.

## Submission Notes

BuildMedic uses GitAgent where it matters: agent identity, rules, skills, read-only tools, streamed events, and auditable tool traces. GitHub metadata comes from Coral SQL. Raw GitHub Actions job logs use one direct downloader because GitHub serves logs as short-lived redirected text, not as JSON rows.

The pitch: BuildMedic turns noisy CI failures into reviewed, approval-ready fixes without giving agents repository write access.
