# Security Review

Analyze proposed patches for security issues and regressions.

## Capability

- Detect introduction of unsafe patterns: eval, innerHTML, SQL concatenation, hardcoded secrets.
- Verify input validation is preserved or added when modifying request handlers.
- Check for path traversal, injection, and deserialization vulnerabilities.
- Identify changes that weaken existing security controls.
- Verify test coverage is not reduced by the patch.
- Flag patches that change authentication, authorization, or cryptographic code.

## Inputs

- Triage report with root cause and evidence.
- Proposed unified diff from the Patch Agent.
- Access to read original file contents for context.

## Outputs

- Verdict: approve, reject, or needs_changes.
- List of concerns with severity ratings.
- Recommendation for how to proceed.
