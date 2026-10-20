# Deployment & Database Migration Guide

## Step 2 Deployment Sequence

To safely deploy the Customer, Investor, and Team Member enrollment changes to production:

### 1. Database Backup (Pre-Deployment)
Always take a full database snapshot or pg_dump prior to running database schema migrations:
```bash
pg_dump -h <DB_HOST> -U <DB_USER> -d <DB_NAME> -F c -b -v -f "backup_mmr_$(date +%Y%m%d_%H%M%S).dump"
```

### 2. Run Database Migrations (BEFORE deploying server code)
Run the two ESM Knex migrations before switching over API server traffic:
1. `migrations/20261021000000_add_is_final_submitted_to_investor_enrollments.js`
   - Adds `is_final_submitted` to `investor_enrollments`.
2. `migrations/20261021000001_add_final_submit_and_terms_to_team_members.js`
   - Adds `is_final_submitted` to `team_members`.
   - Runs the guarded approved-status backfill:
     ```sql
     UPDATE team_members
     SET is_final_submitted = TRUE
     WHERE LOWER(status) = 'approved' AND is_final_submitted = FALSE;
     ```

### 3. Deploy New API Server Code & Frontend
1. Deploy the API server backend (`mmrconstructionsApi`).
2. Deploy the Angular frontend client (`mmrconstructions-main`).

### 4. Post-Deployment Smoke Tests
1. Verify `GET /api/health` returns status `ok`.
2. Verify customer draft save and final submit lock (403 on subsequent draft edit).
3. Verify investor draft save and final submit lock (403 on subsequent draft edit).
4. Verify team member PDF download endpoint `GET /api/team-members/:id/print`.

---

## Important Migration & Backfill Safety Notes

### Why `ensureTeamMembersTable()` does NOT run the backfill:
The runtime `ensureTeamMembersTable()` function runs on API server boot. Its sole role is schema self-healing (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) so that the server does not throw undefined column errors on boot. It intentionally **never** updates existing business data rows or backfills statuses. Data mutations belong exclusively in audited, trackable migration files.

### Backfill Re-Run Safety (Guarded Against SuperAdmin Unlocks):
- In `20261021000001_add_final_submit_and_terms_to_team_members.js`, the backfill is guarded using a PL/pgSQL block:
  - It only updates rows where `is_final_submitted = FALSE`.
  - It checks if `team_member_unlock_audit` exists and explicitly excludes any record that was unlocked by an administrator (`AND team_member_uid NOT IN (SELECT team_member_uid FROM team_member_unlock_audit)`).
- **Audit Row Persistence**: The backfill's unlock-audit guard only protects records that still exist in `team_member_unlock_audit`. **Never delete rows from `team_member_unlock_audit`**, as deleting audit history could cause an unlocked record to be re-locked if a backfill script is re-run.

---

## Environment Rollout Flags & Staging Testing

### `ENFORCE_TM_FINAL_SUBMIT` (Default: OFF / false)
- **Current Default**: `false` (OFF). In this state, existing Team Member approval workflows (associate approval and admin status change) remain unblocked even if a pending record has not been final-submitted.
- **Activation Requirement**: Turn this flag `true` (ON) in environment configuration **only after the Step 3 frontend is live in production**, ensuring that associates have the full UI to final-submit pending records.
- **403-After-Final Edit Lock**: The 403 edit lock on `updateTeamMemberRecord` stays **always active** regardless of this flag, as it only triggers once a record is explicitly marked `is_final_submitted = TRUE`.

### `wasEverApproved` Safety Logic in `updateTeamMemberStatus`:
- In `updateTeamMemberStatus`, approval gating checks whether a member was previously approved (`users.is_verified = true` or `users.account_status IN ('Approved', 'Active')`) so that re-approvals, re-activations, and referral-created members are never blocked.
- **Pre-Rollout Requirement**: This check has not yet been executed against production data; it **must be validated in a staging environment** before setting `ENFORCE_TM_FINAL_SUBMIT=true` in production.

### Staging Verification Script (`verify_investor_enrollment_staging.mjs`):
- Located at `scripts/verify_investor_enrollment_staging.mjs`.
- **Safety Guard**: It prints the target database host on execution and will **abort immediately** unless the environment variable `CONFIRM_STAGING=true` is explicitly set:
  ```powershell
  $env:CONFIRM_STAGING="true"; node scripts/verify_investor_enrollment_staging.mjs
  ```
- **DO NOT** execute this script against a production database.
