## What and why

## How it was tested

## Security checklist

- [ ] Touches auth, permissions, crypto, money or migrations? (flag for extra review)
- [ ] New endpoints validate input with Zod and check object-level scope (404 on out-of-scope)
- [ ] No PII in logs, URLs or error messages
- [ ] New sensitive columns are encrypted and registered in `apps/worker/src/jobs/rotate-keys.ts`
- [ ] New tables have RLS policies + a test proving a role cannot reach them
- [ ] Rates/thresholds/legal periods come from config tables, not code
- [ ] ASVS items touched noted in `docs/security/asvs-checklist-phase1.md` (or the phase's checklist)
