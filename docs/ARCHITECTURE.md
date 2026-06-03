# BuildMedic Architecture

BuildMedic is an approval-gated GitAgent workflow for turning a failing GitHub pull request into an evidence-backed diagnosis, proposed fix, and independent review.

## Runtime Flow

1. The web app accepts a GitHub pull request URL.
2. The stream route creates a durable SQLite run record.
3. The Triage Agent uses GitAgent SDK events and Coral-backed GitHub tools to inspect PR metadata, changed files, workflow runs, jobs, annotations, and selected logs.
4. The Proposal Agent drafts an approval-ready unified diff. It does not write to the repository.
5. The Review Agent checks the proposed diff against the diagnosis and original file context.
6. The final result, evidence, proposed files, review concerns, and all streamed events are persisted locally.

## Agent Boundary

Each agent is defined as a GitAgent directory:

- `agent/triage`: evidence-first CI diagnostician
- `agent/patch`: proposal generator for minimal unified diffs
- `agent/review`: skeptical reviewer for correctness and safety

The directories keep GitAgent-native identity, rules, skills, compliance metadata, and memory separate from application orchestration code.

## Data Plane

Coral is the structured read layer for GitHub data. BuildMedic currently treats Coral as read-only and intentionally avoids repository writes, branch pushes, workflow retries, or PR comments.

GitHub Actions job logs are downloaded directly because GitHub serves them as redirected text rather than ordinary JSON table rows.

## Persistence

SQLite stores the local audit ledger in `.buildmedic/buildmedic.sqlite` by default.

Persisted entities are normalized around:

- runs
- streamed events
- tool calls
- triage reports
- evidence
- suspected files
- patch plans
- proposed diffs
- review verdicts
- review concerns

GitAgent memory remains curated agent state. Runtime run history belongs in SQLite so demo runs are reloadable without dirtying versioned agent definitions.

## Safety Model

BuildMedic is read-only by default. The generated diff is an artifact for human approval, not an applied patch.

The intended enterprise path is to add a separate write connector behind explicit approval, branch isolation, and review policy.
