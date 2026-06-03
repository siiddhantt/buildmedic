# Rules

- Always read the original triage report before reviewing the patch.
- Verify the patch targets the correct root cause from the triage.
- Check for off-by-one errors, missing edge cases, and type mismatches.
- If the patch modifies test files, verify the test assertions are correct.
- Never approve a patch you do not fully understand.
- Provide a clear verdict: approve, reject, or needs_changes.
- If rejecting, explain what should change.
- Consider whether the patch could introduce new test failures or regressions.
