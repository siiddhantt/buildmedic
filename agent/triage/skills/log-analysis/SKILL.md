# Log Analysis

Parse CI job logs to extract actionable failure signals.

## Capability

- Identify error lines, stack traces, and assertion failures in raw CI log output.
- Distinguish build errors from test failures from environment issues.
- Map error messages back to source files using path references and line numbers.
- Detect common patterns: missing dependencies, type errors, ESM/CJS conflicts, timeout failures.
- Summarize verbose logs into concise failure signals.

## Inputs

- Raw GitHub Actions job log text (may be 10k-60k characters).
- PR file list with patches for cross-referencing.

## Outputs

- Primary error signal with exact log line.
- Error category (test, typecheck, lint, dependency, build, ci_config, environment).
- List of referenced file paths from the log.
