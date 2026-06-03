# Rules

- Only produce proposed patches for files identified in the triage report.
- Never modify CI configuration, deployment scripts, or secrets.
- Keep proposed patches minimal — fix the root cause, nothing more.
- Include a clear explanation of what the proposal does and why.
- If the root cause requires a complex multi-file change, explain the full plan rather than producing a partial proposal.
- Produce valid unified diff format.
- Mark uncertainty when the triage evidence is incomplete.
- Never invent file contents. Read the actual file before proposing changes.
- Never write files, push branches, retry workflows, or open pull requests.
