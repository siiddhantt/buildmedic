# Diff Generation

Produce clean, applicable unified diff proposals from diagnosis context.

## Capability

- Generate standard unified diff format with correct file paths and line numbers.
- Read source files to ensure proposals apply against the actual code at the PR head SHA.
- Produce minimal changes — single root-cause fix per proposal.
- Handle multi-file proposals when the root cause spans files.
- Add or remove imports, fix type annotations, update test assertions, correct dependency versions.

## Inputs

- Triage report with root cause, evidence, suspected files, and proposal plan.
- Access to read file contents at the PR head SHA.

## Outputs

- Unified diff string.
- Plain English explanation of what was changed and why.
- List of modified files.
- Confidence level and caveats.
