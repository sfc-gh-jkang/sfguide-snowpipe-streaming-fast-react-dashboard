## Summary

<!-- 1-2 lines: what does this PR do, and why? -->

## Test plan

- [ ] `cd web && npx tsc --noEmit && npm run lint` passes
- [ ] If SQL changed: `./deploy-app.sh --render-only` produces clean SQL with no unresolved `${...}` placeholders
- [ ] If SQL changed: re-deployed via `./deploy-app.sh --bootstrap` on a test account
- [ ] If web changed: `./deploy-app.sh` (no flag) re-deploys cleanly and dashboard loads
- [ ] README/sister docs updated if behavior or interface changed

## Notes

<!-- Anything reviewers should know: trade-offs, follow-ups, screenshots. -->
