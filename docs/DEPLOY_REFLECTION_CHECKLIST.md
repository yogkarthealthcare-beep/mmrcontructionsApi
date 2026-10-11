# MMR Construction — Production Deployment Reflection & Verification Runbook

**Document Path:** `docs/DEPLOY_REFLECTION_CHECKLIST.md`  
**Date:** October 2026  
**Status:** **Strict Pre-Requisite Runbook (Do NOT flip flag until prerequisites pass)**  

---

## 1. Why Newly Published Code Does Not Reflect (5-Point Root Cause Analysis)

### Root Cause 1: Angular Production Feature Flag is `false`
- **Location:** `src/environments/environment.prod.ts`
- **Mechanism:** In `angular.json`, production builds activate file replacement:
  ```json
  "fileReplacements": [
    {
      "replace": "src/environments/environment.ts",
      "with": "src/environments/environment.prod.ts"
    }
  ]
  ```
- **Impact:** In `environment.prod.ts`, `features.bookingAttribution` is set to `false`. When compiled with `ng build --configuration production`, all Phase 3 attribution screens (Leaderboards, Approvals, Unattributed Bookings, Booking Attribution Wizard, and Team Member Attribution KPIs) are dynamically hidden from navigation menus and blocked by route guards.
- **Rule:** Flag must remain `false` until backend migrations and APIs are verified live on the VPS.

### Root Cause 2: Backend Code Not Reloaded / Running Stale Process
- **Mechanism:** If new Git commits are pulled on the VPS but PM2 is not reloaded, Express continues executing the old in-memory JavaScript bytecode.
- **Verification:**
  ```bash
  curl -i https://<your-domain>/api/booking-capabilities
  ```
  - **If HTTP 200 with JSON capabilities:** New backend is active.
  - **If HTTP 404 Not Found:** Backend is running old code or new routes are not mounted.

### Root Cause 3: Database Migrations Not Executed on VPS
- **Mechanism:** The new booking attribution APIs query new schema columns (`sold_by_user_id`, `associate_user_id`, `associate_approval_status`) and views (`vw_sales_attribution`).
- **Verification:**
  ```bash
  cd /var/www/mmrconstructionsApi
  npx knex migrate:status
  ```
  Both `20261010000000_sales_attribution_and_booking_hierarchy.js` and `20261011000000_sales_attribution_phase2.js` must show as **Completed**.

### Root Cause 4: Frontend `dist/` Output Not Copied to Nginx Web Root
- **Mechanism:** Running `ng build --configuration production` creates files in `dist/mmr-constructions/browser` (or `dist/mmr-constructions`). If Nginx `root` directive points to `/var/www/html` or `/var/www/mmrconstructions/dist` and the build output was not copied there, Nginx continues serving old hashed chunks (e.g., `main.xxxx.js`).
- **Browser Cache:** Browsers cache `index.html` or service workers. A hard refresh (`Ctrl + Shift + R`) or Incognito window is required. If Cloudflare is enabled, purge cache.

### Root Cause 5: PM2 Process Failure or Silent Crash Loop
- **Mechanism:** If backend starts with an unhandled exception (e.g. database connection failure or missing environment variable), PM2 may restart repeatedly or serve error pages.
- **Verification:**
  ```bash
  pm2 status
  pm2 logs --lines 50
  ```

---

## 2. Mandatory Pre-Deployment Verification Checklist (Prerequisites)

Before running migrations or modifying any production configuration, complete all 6 prerequisites:

- [ ] **Prerequisite 1: Phase 1 Read-Only Diagnostics Run on VPS:**
  Run `scripts/phase1_data_quality_report.js` or `scripts/team_member_role_conflict_report.sql` on the VPS to confirm zero blocking data anomalies.
- [ ] **Prerequisite 2: Migration Dry-Run on Production Schema-Only Dump:**
  Test migrations locally against a schema-only dump of the production database (`test_migration_full.cjs`) to guarantee zero DDL errors.
- [ ] **Prerequisite 3: Manual Database Backup Taken by User on VPS:**
  Perform a full manual database backup on the VPS:
  ```bash
  pg_dump -U <username> -d mmrconstructions -F c -b -v -f /backup/db_pre_attribution_$(date +%F).dump
  ```
- [ ] **Prerequisite 4: Confirmation of `TEAM_MEMBER_AUTOHEAL=off`:**
  Verify that `TEAM_MEMBER_AUTOHEAL` is NOT set to `true` in the VPS `.env` file to prevent unwanted startup writes.
- [ ] **Prerequisite 5: Knex Migration Order Verified:**
  Confirm migration execution sequence:
  1. `20261010000000_sales_attribution_and_booking_hierarchy.js`
  2. `20261011000000_sales_attribution_phase2.js`
- [ ] **Prerequisite 6: Backend Endpoint Verification:**
  Curl `http://127.0.0.1:5000/api/booking-capabilities` returning HTTP 200 with JSON capability payload.

---

## 3. Production Deployment Step-by-Step Execution

### Step 1: Backend Deployment & Migration
```bash
cd /var/www/mmrconstructionsApi
git pull origin main

# Confirm Knex migration status
npx knex migrate:status

# Run forward migrations
npx knex migrate:latest

# Reload Express application gracefully
pm2 reload ecosystem.config.js --update-env
pm2 status

# Verify capability endpoint
curl -s http://127.0.0.1:5000/api/booking-capabilities | grep "capabilities"
```

### Step 2: Frontend Build & Publish (Flag Flip)
**Only proceed to this step after Step 1 has completed with HTTP 200:**
```bash
cd /var/www/mmrconstructions-main
git pull origin main

# Once backend is verified live, set flag to true:
# In src/environments/environment.prod.ts: features.bookingAttribution = true

# Build production bundle
ng build --configuration production

# Copy build artifacts to Nginx web root (per nginx.conf)
# Example: cp -r dist/mmr-constructions/browser/* /var/www/html/
nginx -t && systemctl reload nginx
```

### Step 3: Post-Deployment Verification
1. Open browser in **Incognito Mode**.
2. Verify `https://<domain>/api/booking-capabilities` returns HTTP 200.
3. Login as Admin -> Team Members -> click "Login as Team Member" -> verify lands on `/team-member/dashboard`.
4. Hard-refresh (`Ctrl + Shift + R`) to ensure no stale assets are cached.
