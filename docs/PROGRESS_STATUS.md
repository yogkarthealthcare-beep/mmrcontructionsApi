# MMR Construction & Developers Pvt. Ltd. — Progress Status Report

**Document Path:** `docs/PROGRESS_STATUS.md`  
**Date:** October 2026  
**Repositories:** `mmrconstructionsApi` (Backend), `mmrconstructions-main` (Angular Frontend)  
**Status Audit:** **STRICT HONEST RE-LABELING: Code done vs Verified with fresh output vs Not run**  

---

## 1. Business Requirements Status Matrix

| Business Requirement | Status | Evidence (File : Line / Commit) | Verification State |
| :--- | :---: | :--- | :---: |
| **1. Customer map se apne liye booking (pehle jaisa)** | **Code done, not run** | Frontend: `customer-plot-selection.component.ts` sets `buyerType: 'SELF'`.<br>Backend: `booking-workflow.routes.js:75` handles direct customer booking. | **NOT RUN** in this session (local browser E2E test pending). |
| **2. Team Member apne liye aur apne customer ke liye booking** | **Code done, not run** | Frontend: `shared/book-plot/book-plot.component.ts` toggles `SELF` vs `CUSTOMER`.<br>Backend: `services/bookingService.js:410-445`, sets `booked_by_user_id` and attribution. | **NOT RUN** in this session (browser wizard test pending). |
| **3. Associate apne aur team ke customers ke liye booking** | **Code done, not run** | Frontend: `associate.routes.ts`, `my-team.component.ts`.<br>Backend: `routes/booking-workflow.routes.js:210-280`. | **NOT RUN** in this session. |
| **4. Har booking par Team Member ka reference (`sold_by`, `associate`, `booked_by`, `booking_type`)** | **Code done, not run** | Database: Migration `20261010000000_sales_attribution_and_booking_hierarchy.js`.<br>View: `vw_sales_attribution`.<br>Backend: `booking-approvals.routes.js:120`. | **NOT RUN** on live DB in this session. |
| **5. Team Member-wise plots sold ranking & Associate-wise ranking** | **Code done, not run** | Backend: `routes/sales-attribution-reports.routes.js` (`GET /leaderboard/team-members`, `GET /leaderboard/associates`).<br>Frontend: `src/app/admin/leaderboards/leaderboards.component.ts`. | **NOT RUN** on live DB in this session. |
| **6. Associate approval step; admin confirm guard; override** | **Code done, not run** | Database: Migration `20261011000000_sales_attribution_phase2.js` (`associate_approval_status`).<br>Backend: `routes/booking-approvals.routes.js` (approve, reject, override).<br>Frontend: `admin/approvals/` and `associate/approvals/`. | **NOT RUN** on live DB in this session. |
| **7. Company Direct / Legacy Ambiguous customers & admin referrer assign + bulk resolve** | **Code done, not run** | Backend: `routes/admin-attribution.routes.js` (`GET /unattributed`, `PATCH /users/:id/referrer`, `POST /users/bulk-referrer-assignment`).<br>Frontend: `src/app/admin/unattributed-bookings/unattributed-bookings.component.ts`. | **NOT RUN** on live DB in this session. |

---

## 2. Phase-Wise Milestone Checklist

### Phase 1, 1B, 1C: Database Architecture & Attribution Schema
- [x] **Phase 1 Migration (`20261010000000_sales_attribution_and_booking_hierarchy.js`):** Schema columns (`sold_by_user_id`, `associate_user_id`, `booked_by_user_id`, `booking_type`, `referred_by_source`) and view `vw_sales_attribution` defined in migration file.
- [x] **Phase 1B Migrations (`20261011000000_sales_attribution_phase2.js`):** `associate_approval_status` enum, `associate_approval_overridden`, and indices defined in migration file.
- [ ] **Phase 1C Production Diagnostics & Dry-Run:** Diagnostic script `scripts/team_member_role_conflict_report.sql` and `phase1_prod_readonly_diagnostics.sql` prepared; pending execution on VPS.

### Phase 2, 2B: Backend APIs & Workflow Controllers
- [x] **Attribution Reporting Routes:** `routes/sales-attribution-reports.routes.js` implemented.
- [x] **Booking Approval Endpoints:** `routes/booking-approvals.routes.js` implemented.
- [x] **Admin Unattributed Endpoints:** `routes/admin-attribution.routes.js` implemented.
- [x] **Capabilities Endpoint:** `GET /api/booking-capabilities` implemented in `server.js`.
- [x] **Referral Resolver Service:** `services/referralResolver.service.js` implemented.

### Phase 3, 3B: Angular Frontend UI & State
- [x] **Admin Leaderboards:** `src/app/admin/leaderboards/` component created.
- [x] **Admin Unattributed Screen:** `src/app/admin/unattributed-bookings/` component created.
- [x] **Approvals Screens:** `src/app/admin/approvals/` and `src/app/associate/approvals/` components created.
- [x] **Book-Plot Shared Wizard:** `src/app/shared/book-plot/` component created.
- [x] **Production Feature Flag Config:** Set to `false` in `src/environments/environment.prod.ts` (safe mode).

---

## 3. Phase 3C Specific 9-Task Audit & True Status

| Phase 3C Sub-Task | Current True Status | Technical State & Evidence |
| :--- | :---: | :--- |
| **(1) ACL commands list + terminal state** | **Audited & Compliant** | Windows sandbox subshell NTFS DACL restrictions cause warnings on select inherited folders. In accordance with strict instructions, zero permission commands (`icacls`, `takeown`, `attrib`) were executed. Local file integrity confirmed via direct IDE inspections. |
| **(2) Fresh raw outputs (backend suite, tsc, build, lint, ng test)** | **NOT RUN** | Terminal subshell lacks `node.exe` in `$env:PATH`, and `npm` invocation via `npm.ps1` was blocked by PowerShell execution policy (`PSSecurityException`). Per strict instructions, no workaround or bypass was executed. |
| **(3) Flag-off equivalence for Team Member** | **Code done, not run** | Code changes in `auth.guard.ts` decoupled `teamMemberGuard` from `features.bookingAttribution`. Browser verification is NOT RUN. |
| **(4) Server-side Cash/Cheque restriction** | **Code done, not run** | Frontend UI dropdowns removed Cash/Cheque. Backend payment validation schema exists in code, NOT RUN against live requests in this session. |
| **(5) Earnings/commission audit** | **Code done, not run** | Uncalculated `total_commission_earned` removed from `leaderboards.component.html` and replaced with `total_sales_value`. Dashboard commission audit is pending/NOT RUN. |
| **(6) `/api/admin/bookings` compatibility** | **Code done, not run** | Real endpoint mounted in `server.js` with additive attribution fields. Connected to `booking-management.component.html`. Live HTTP test is NOT RUN. |
| **(7) `auth.middleware.js` diff** | **Verified (Git Diff)** | Verified clean exports `verifyUserToken`, `verifyAdminToken`, and `role`. |
| **(8) Frontend unit/component tests** | **NOT RUN** | Unit test suite has not been executed due to terminal subshell path and execution policy restrictions. |
| **(9) Referral flow proof** | **Code done, not run** | Implemented in `services/referralResolver.service.js`, NOT RUN on terminal in this session. |

---

## 4. Production Deployment Reflection Analysis (Why published changes didn't show)

1. **Feature Flag is `false` in `environment.prod.ts`:**
   During production build (`ng build --configuration production`), Angular swaps `environment.ts` with `environment.prod.ts`. Because `features.bookingAttribution = false`, all attribution routes, leaderboards, and approvals are hidden by design until backend migrations are verified.
2. **Backend Live Verification:**
   Verify `https://<domain>/api/booking-capabilities`. If it returns HTTP 404, PM2 has not reloaded the new backend code.
3. **Database Migrations Pending on VPS:**
   The new endpoints require columns from `20261010000000_sales_attribution_and_booking_hierarchy.js` and `20261011000000_sales_attribution_phase2.js`. Run `npx knex migrate:status` to confirm they are **Completed**.
4. **Nginx Web-Root Copy:**
   Confirm that the `dist/mmr-constructions/browser` output was copied to the Nginx active root folder specified in `nginx.conf`.
5. **Browser & Cloudflare Cache:**
   Perform a hard refresh (`Ctrl + Shift + R`) or open in Incognito to clear cached JavaScript bundles.

---

## 5. Round 2 Gap Remediation Audit (Tasks C1 to C6)

| Remediation Item | True Status | Technical Implementation & Evidence |
| :--- | :---: | :--- |
| **C1. Tight Team Membership Matching** | **Code implemented** | Removed loose `mobile_no` and `team_member_uid = member_id` matching everywhere (`server.js:5876`, `server.js:13169`, `server.js:6065`, `routes/newRoutes.js:371`, `services/teamMemberService.ts:86`, `services/teamMemberService.js:82`). Strict match: `team_members.user_id = users.user_id AND LOWER(status) IN ('approved', 'active')`. |
| **C2. Backend `acting_panel` Helper & Scoping** | **Code implemented** | Centralized `resolveEffectivePanel(user)` exported from `middleware/auth.middleware.js` and defined in `server.js`. `acting_panel = 'team-member'` is strictly accepted only when issued with `impersonated_by_admin_id`. Associate-only routes (`requireAssociate`, `/api/associate/booking-approvals`, `/api/associates/:id/team-sales`, `/api/associate-enrollment/*`) return **HTTP 403** when acting as Team Member. TM APIs (`sales-summary`, `customers-sales`, `my-bookable-customers`) strictly scope to `req.user.user_id`. |
| **C3. Optional Safe Mode (`team_membership_if_no_associate_business`)** | **Code implemented** | Implemented in `routes/newRoutes.js` (default stays `db`). Elevates effective role to `Team Member` only if: (a) C1 tight match active, (b) user has NO completed Associate enrollment, and (c) user has NO sponsored downline (`sponsor_user_id`), customer referrals (`referred_by_user_id`), or team members (`team_members.associate_id`). |
| **C4. Frontend Fallback Removal & Token Security** | **Code implemented** | Removed forged fallback object `{ user_type: 'Team Member' }` in `team-members.component.ts:425` and `impersonate-login.component.ts:60`. If `!user?.user_id`, session generation stops and displays explicit error. Security analysis documented for token in URL query parameter. |
| **C5. Missing Diffs & Permission Audit** | **Documented** | Raw diffs captured for `middleware/auth.middleware.js`, `db.js`, `emailService.js`. Identified why `git diff --stat` failed on `services/`: Windows subshell file system reports `Permission denied / could not open directory 'services/'` to git binary. Direct file system access confirmed files intact. |
| **C6. Test Execution Status** | **NOT RUN** | Node is not present in `$env:PATH` (`where.exe node` returned exit code 1: "Could not find files"). Per strict prompt rules, tests are honestly marked **NOT RUN** (zero fake passes). |

---

## 6. Next Steps & Prioritization

### High Priority (For User to Run on VPS / Local PowerShell)
1. **Run Diagnostic SQL on VPS:**
   Execute `scripts/team_member_role_conflict_report.sql` on the VPS database to inspect role conflict counts (Cases A–G).
2. **Execute Database Migrations on VPS:**
   ```bash
   cd /var/www/mmrconstructionsApi
   npx knex migrate:status
   npx knex migrate:latest
   ```
3. **Restart PM2 & Test Capabilities Endpoint:**
   ```bash
   pm2 reload ecosystem.config.js --update-env
   curl -i http://127.0.0.1:5000/api/booking-capabilities
   ```
4. **Decide on Role Policy:**
   Review `docs/TEAM_MEMBER_ROLE_POLICY_OPTIONS.md` and choose between Option 1 (Single Role Conversion) and Option 2 (Two Distinct Accounts).
