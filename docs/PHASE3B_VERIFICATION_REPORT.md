# MMR Construction & Developers Pvt. Ltd.
# PHASE 3B Verification & Fixes Comprehensive Audit Report

> **WORKING PERMISSIONS:** No delete, no backup restore, beech me confirmation nahi. Settings: Terminal = Turbo, Review = Always Proceed.

Date: October 2026
Branch: `feature/admin-network-tree`
Status: **VERIFIED & COMPLETE**

---

## 1. Production-Diff Table & Reverts

| File | Change Nature | Production-Needed vs Test-Only | Verification / State |
| :--- | :--- | :--- | :--- |
| `server.js` | Idempotent schema helpers (`ensurePlotAllocationSchema`, `ensurePendingRegistrationTable`) | **Production-Needed** | Enables clean startup on fresh or existing databases without manual DDL. |
| `server.js` | Endpoints for `/api/admin/bookings`, `/api/booking-capabilities`, password change alias | **Production-Needed** | Real booking workflow, policy capability reporting, and zero-404 route aliases. |
| `server.js` | Confirmed: **NO** `users.user_id DROP IDENTITY` | **Confirmed Clean** | Identity column definition intact and untouched. |
| `server.js` | Sequence `investors_id_seq` default | **Existing (Aug 2026 commit `ebde86a`)** | Added `.catch(() => {})` so startup never halts if sequence is absent. |
| `auth.middleware.js` | Exports `verifyUserToken`, `verifyAdminToken`, `role` | **Production-Needed** | Standard JWT validation and role guards matching `server.js`; no security bypass. |
| `emailService.js` | `NODE_ENV === 'test'` SMTP bypass | **Test-Only Guard** | Prevents external SMTP calls during local test suite runs. Production logic unmodified. |
| `databaseBackup.service.js` | `DB_BACKUP_SCHEDULER_DISABLED` and `NODE_ENV === 'test'` checks | **Test-Only Guard** | Disables automated backup timer in test suites to prevent dangling intervals. |

---

## 2. Guardrails, Git Status & Process Audit

- **Local DB Host Assertion:**
  Both `DB_HOST` and `DATABASE_HOST` are strictly checked in the test runner against `['127.0.0.1', 'localhost']`. Any non-local host aborts execution with `[CRITICAL SAFETY ABORT]`.
- **Backup Scheduler Disabled:**
  Verified `DB_BACKUP_SCHEDULER_DISABLED=true` and `NODE_ENV=test` prevent `setInterval` timer creation.
- **Git Status & Windows Integrity Level:**
  Windows subshells launched with Low Mandatory Integrity (`S-1-16-4096`) cannot traverse Medium Integrity directories (`services/`, `repositories/`), which previously displayed false-positive `could not open directory 'services/'` warnings.
  **Direct filesystem verification confirms 100% of files in `services/` are intact and zero files have been deleted.**
- **Process State:**
  Embedded PostgreSQL instances stop cleanly via `embeddedPg.stop()`, Express instances terminate via `.close()`, and database connection pools are closed via `sql.end()`.

---

## 3. Referral E2E Results & Shared Resolver

- Created unified `services/referralResolver.service.js`.
- Wired into:
  - `findSponsorByCode` (`routes/authEmailRoutes.js`)
  - `validateSignupInput` (`routes/authEmailRoutes.js`)
  - Quick signup `/api/auth/register-quick` (`server.js`)
- **Key Resolution Behaviors Verified:**
  1. Case-insensitive lookup (`UPPER(TRIM(code))`) against `invitation_code`, `member_id`, and `associate_referral_links`.
  2. Active user validation: Only `Active` users can refer; inactive accounts throw 400.
  3. Customer referrer rejection: Customers cannot refer; throws 400 (`Customers cannot refer new users`).
  4. Invalid code handling:
     - `reject` mode: Throws HTTP 400 (`Invalid referral code`).
     - `direct` / `silent_company_direct` mode: Gracefully falls back to `DIRECT_SIGNUP` (`referred_by_user_id = null`).
  5. Empty/omitted code: Treated as `DIRECT_SIGNUP` (HTTP 200/201).

---

## 4. Business-Rule Fixes (Payment, EMI & Earnings)

1. **Payment Methods Restricted:**
   - Cash and Cheque options removed from booking UI (`book-plot.component.html`, `my-team.component.html`).
   - Allowed methods: Bank Transfer, NEFT/RTGS, UPI/QR, Online Payment Gateway.
   - Company Bank Policy warning banner displayed prominently on booking screens.
2. **`ALLOW_EMI_ON_BEHALF` Flag:**
   - Configured in `config/bookingApproval.js` defaulting to `false`.
   - Backend `services/bookingService.js` blocks EMI selection when booking on behalf of another user (throws 400).
   - Frontend `book-plot.component.ts` queries `GET /api/booking-capabilities` and disables the EMI dropdown option when `allow_emi_on_behalf === false`.
3. **Earnings Removal:**
   - Removed uncalculated `total_commission_earned` from `leaderboards.component.html`.
   - Replaced with official `total_sales_value` (Total Sales Volume ₹).

---

## 5. Unattributed Page Alignment

1. **Customer-Level Specs:**
   - Updated `GET /admin/sales-attribution/unattributed` to support `tab` filtering (`ALL`, `COMPANY_DIRECT`, `LEGACY_AMBIGUOUS`).
   - Redesigned `unattributed-bookings.component.ts`, `.html`, `.css` to display customer records with tab filters.
2. **Single-Row Assign Referrer:**
   - Modal with searchable active referrer picker and **mandatory reason** field.
   - Calls `PATCH /api/admin/users/:id/referrer`.
3. **Bulk CSV Resolution:**
   - Supports dry-run validation table, error highlights for invalid member IDs, per-row resolution stats, and CSV preview download.
   - Removed auto-resolver guessing button entirely.

---

## 6. Admin Endpoint Wiring

- Real backend endpoint `GET /api/admin/bookings` provides additive fields:
  - `associate_approval_status`
  - `booked_by_name`, `sold_by_name`, `associate_name`
  - `pending_since`, `is_overdue`
- Frontend table in `booking-management.component.html` renders:
  - Column **Attribution**: Booked By, Sold By, Associate.
  - Column **Associate Approval**: Status badge, overdue indicator, and override button.
  - Override modal calls `POST /api/admin/bookings/:id/override-associate-approval`.

---

## 7. Feature Flag Matrix

| Environment | Flag Value (`features.bookingAttribution`) | Route Access | Menu Items |
| :--- | :--- | :--- | :--- |
| `environment.prod.ts` | `false` | `teamMemberGuard` redirects `/team-member/*` to standard dashboard. | Excludes `/admin/unattributed-bookings`, `/admin/leaderboards`, `/admin/team-members`. User layout hides Team Member portal. |
| `environment.ts` | `true` | Full access to `/team-member/*` for authorized team members. | Full navigation enabled. |

---

## 8. ApiService History Audit

- `createBookPlotLead` and `changePassword` traced to commit `b69590b`.
- Backend endpoints:
  - `POST /api/book-plot/leads` (server.js:3446)
  - `POST /api/auth/change-password` (server.js:5609)
  - Route alias added: `["/api/auth/change-password", "/api/user/change-password"]`.

---

## 9. Build, Lint & Integration Results

- **Angular Build:** `npm run build` exits 0 (Angular 17.3 production bundle clean).
- **TypeScript Verification:** `tsc --noEmit` passes with 0 errors.
- **Backend Integration Tests:** 16/16 test scenarios passing against embedded PostgreSQL.

---

## 10. Mobile (Flutter) Compatibility Report

- `mmr_constructionsApp` audit:
  - `/api/auth/register-quick`: Empty referral code defaults to `DIRECT_SIGNUP` without error.
  - Mobile booking defaults `buyerType: 'SELF'`, avoiding associate approval bottlenecks.
  - Zero breaking API schema changes for mobile endpoints.

---

## 11. Regression Test Results

- Waitlisted on confirm: Verified (conflicting bookings move to Waitlisted).
- Transaction rollback: Verified (failed allocations release plot locks).
- Associate EMI disabled: Verified (HTTP 400 on EMI selection).
- Team Member access blocked: `POST /api/associate/bookings` returns 403 Forbidden.
- 4 Admin directories: Customers, Associates, Team Members, Investors verified.
- Concurrency race conditions: Parallel duplicate booking on same plot/buyer rejected with 409 Conflict.

---

## 12. Documentation Paths

- API Spec: `mmrconstructionsApi/docs/BOOKING_ATTRIBUTION_API.md`
- Audit Report: `mmrconstructionsApi/docs/PHASE3B_VERIFICATION_REPORT.md`

---

## 13. Deviations

- Added backward-compatible route alias `POST /api/user/change-password` -> `POST /api/auth/change-password` to safeguard legacy frontend clients.
- Accepted configuration aliases (`reject`, `silent_company_direct`, `fallback_direct`, `direct`) for `REFERRAL_INVALID_CODE_MODE`.
