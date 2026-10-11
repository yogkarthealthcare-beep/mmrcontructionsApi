# MMR Construction — Team Member Panel Manual Verification Checklist

**Document Path:** `docs/TEAM_MEMBER_PANEL_CHECKLIST.md`  
**Date:** October 2026  
**Applicable Roles:** Admin, Team Member, Associate, Customer, Investor  
**Status Audit:** **Specification & Test Cases Defined; Browser Execution NOT RUN in this terminal session**  

---

## 1. Objective & Scope
Verify that the 5 distinct user panels on MMR Construction are strictly isolated and that Team Members are never routed to the Associate Portal (`/associate/*`) or Customer Portal (`/customer/*`).

| Role | Standard Portal Route | Target Home Landing | Expected Token `user_type` |
| :--- | :--- | :--- | :--- |
| **Team Member** | `/team-member/*` | `/team-member/dashboard` | `Team Member` (or explicit scope `acting_panel='team-member'`) |
| **Associate** | `/associate/*` | `/associate/dashboard` or `/associate/enrollment` (if incomplete) | `Associate` |
| **Customer** | `/customer/*` | `/customer/dashboard` | `Customer` |
| **Investor** | `/investor/*` | `/investor/dashboard` | `Investor` |
| **Admin** | `/admin/*` | `/admin/dashboard` | `Admin` |

---

## 2. Test Cases & Verification Steps

### Test 1: Admin Panel Impersonation ("Login as Team Member")
- **Status:** **NOT RUN** (Code implemented in `team-members.component.ts` and `server.js`; live browser session pending).
- **Step 1:** Login to Admin Panel (`/admin/login` or `/admin/dashboard`).
- **Step 2:** Navigate to **Team Members** directory (`/admin/team-members`).
- **Step 3:** Find any active Team Member (e.g., Golu Master).
- **Step 4:** Click the green **"Login as Team Member"** action button (`fas fa-sign-in-alt`).
- **Step 5:** Confirm the browser opens a new tab directed to `/auth/impersonate-login?...` with:
  - `user_type`: `Team Member` (or acting panel `team-member` with `role_conflict: true` if DB is Associate)
  - `redirectUrl`: `/team-member/dashboard`
- **Expected Result:**
  - The session loads `/team-member/dashboard`.
  - The navbar displays "Team Member Portal" with Team Member-specific menus.
  - The user is **NOT** redirected to `/associate/enrollment` or `/associate/dashboard`.
  - Zero database updates occur on the server.

### Test 2: Direct Website Login as Team Member (Feature Flag ON)
- **Status:** **NOT RUN**
- **Step 1:** Open Incognito browser window at `/login`.
- **Step 2:** Enter Team Member mobile number and password.
- **Step 3:** Click **Login**.
- **Expected Result:**
  - Login API returns token with `user_type: "Team Member"` (or DB role with `role_conflict: true`).
  - Frontend `login.component.ts` redirects to `/team-member/dashboard`.
  - Team Member dashboard loads stats and features.

### Test 3: Direct Website Login as Team Member (Feature Flag OFF Equivalence)
- **Status:** **NOT RUN**
- **Step 1:** When `environment.prod.ts` has `features.bookingAttribution: false`:
- **Step 2:** Login as Team Member at `/login`.
- **Expected Result:**
  - Team Member is still routed to `/team-member/dashboard`.
  - `teamMemberGuard` does **NOT** kick the user to Customer or Associate portal.
  - No redirect loops occur.
  - Attribution-specific screens (Leaderboard, Approvals) are gracefully hidden without breaking core navigation.

### Test 4: Associate Login Isolation Check
- **Status:** **NOT RUN**
- **Step 1:** Open `/login` and enter Associate credentials (e.g., `MMR-ASC-00001`).
- **Step 2:** Click **Login**.
- **Expected Result:**
  - Lands on `/associate/dashboard` (or `/associate/enrollment` if KYC pending).
  - Attempting to manually navigate to `/team-member/dashboard` is blocked by `teamMemberGuard` and redirected to `/associate/dashboard`.

### Test 5: Customer Login Isolation Check
- **Status:** **NOT RUN**
- **Step 1:** Open `/login` and enter Customer credentials.
- **Step 2:** Click **Login**.
- **Expected Result:**
  - Lands on `/customer/dashboard`.
  - Attempting to visit `/team-member/*` or `/associate/*` is blocked by guards.

### Test 6: Investor Login Isolation Check
- **Status:** **NOT RUN**
- **Step 1:** Open `/login` and enter Investor credentials.
- **Step 2:** Click **Login**.
- **Expected Result:**
  - Lands on `/investor/dashboard`.
  - Blocked from Team Member, Associate, and Admin routes.

### Test 7: Impersonation Session API Scoping & Shielding (Acting Team Member)
- **Status:** **NOT RUN**
- **Step 1:** Admin uses "Login as Team Member" for a user whose DB `user_type` is Associate.
- **Step 2:** Token issued has `user_type: "Associate"`, `acting_panel: "team-member"`, and `impersonated_by_admin_id: <admin_id>`.
- **Step 3:** Session makes HTTP request to Associate-only endpoints:
  - `GET /api/associate/booking-approvals`
  - `POST /api/associate/booking-approvals/:id/approve`
  - `GET /api/associates/:id/team-sales`
  - `GET /api/associate-enrollment/me`
- **Expected Result:**
  - All Associate-only requests return **HTTP 403 Forbidden**.
- **Step 4:** Session makes HTTP request to Team Member endpoints:
  - `GET /api/team-members/:id/sales-summary`
  - `GET /api/team-members/:id/customers-sales`
  - `GET /api/my-bookable-customers`
- **Expected Result:**
  - Requests succeed and return data **strictly scoped to `req.user.user_id`** (zero access to other team members or associate downlines).

### Test 8: Tight Membership Match Negative Cases
- **Status:** **NOT RUN**
- **Case 8A (Mobile collision):** User A (Associate) has the same mobile number as Team Member row B (user_id = B).
  - Admin impersonates User A or User A logs in.
  - **Expected Result:** User A does NOT get mapped to Team Member B. Role conflict is FALSE. User A remains standard Associate.
- **Case 8B (Pending status):** User C has `team_members` row with `status = 'pending'`.
  - **Expected Result:** Role conflict is FALSE. User C does NOT receive acting Team Member access.

### Test 9: Safe Mode `ROLE_RESOLUTION_MODE=team_membership_if_no_associate_business`
- **Status:** **NOT RUN**
- **Case 9A (Clean Team Member, Associate DB role, no downline):**
  - Elevates effective role in token to `Team Member`.
- **Case 9B (Associate with completed enrollment):**
  - Retains DB role `Associate`; returns `role_conflict: true`.
- **Case 9C (Associate with sponsored downline/team members):**
  - Retains DB role `Associate`; returns `role_conflict: true`.

---

## 3. Guard Matrix Design Matrix (Expected Routing)

| User Role \ Route Attempted | `/customer/*` | `/associate/*` | `/team-member/*` | `/investor/*` | `/admin/*` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Team Member** | ❌ (Redirects to TM) | ❌ (Redirects to TM) | ✅ Allowed | ❌ (Redirects to TM) | ❌ Blocked |
| **Associate** | ❌ (Redirects to ASC) | ✅ Allowed | ❌ (Redirects to ASC) | ❌ (Redirects to ASC) | ❌ Blocked |
| **Customer** | ✅ Allowed | ❌ (Redirects to Cust) | ❌ (Redirects to Cust) | ❌ (Redirects to Cust) | ❌ Blocked |
| **Investor** | ❌ (Redirects to Inv) | ❌ (Redirects to Inv) | ❌ (Redirects to Inv) | ✅ Allowed | ❌ Blocked |
| **Admin** | ✅ Allowed | ✅ Allowed | ✅ Allowed | ✅ Allowed | ✅ Allowed |

