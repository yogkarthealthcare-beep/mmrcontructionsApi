# MMR Construction & Developers Pvt. Ltd.
# Booking Attribution & Sales Hierarchy API Specification (Phase 2 & 2B)

This document provides the definitive specification for all booking creation, associate approval, admin confirmation, reporting, leaderboards, and attribution management endpoints.

---

## 1. Authentication & Role Matrix

| Endpoint | Roles Allowed | Auth Middleware |
| :--- | :--- | :--- |
| `POST /api/bookings` | `Customer`, `Team Member`, `Associate` | `verifyUserToken` |
| `POST /api/team-members/bookings` | `Team Member` | `verifyUserToken` (Role: `Team Member`) |
| `POST /api/associate/bookings` | `Associate` | `verifyUserToken`, `requireAssociate` |
| `POST /api/admin/bookings/:id/confirm` | `SuperAdmin`, `Admin`, `FinanceManager` | `verifyAdminToken`, `role` |
| `POST /api/admin/bookings/:id/offline/approve` | `SuperAdmin`, `Admin`, `FinanceManager` | `verifyAdminToken`, `role` |
| `POST /api/admin/bookings/:id/cancel` | `SuperAdmin`, `Admin`, `FinanceManager` | `verifyAdminToken`, `role` |
| `GET /api/associate/booking-approvals/pending` | `Associate` | `verifyUserToken`, `requireAssociate` |
| `POST /api/associate/booking-approvals/:id/approve` | `Associate` | `verifyUserToken`, `requireAssociate` |
| `POST /api/associate/booking-approvals/:id/reject` | `Associate` | `verifyUserToken`, `requireAssociate` |
| `GET /api/team-members/:id/sales-summary` | `Team Member` (Self), `Associate` (Upline), `Admin` | `verifyUserToken` |
| `GET /api/team-members/:id/customers-sales` | `Team Member` (Self), `Associate` (Upline), `Admin` | `verifyUserToken` |
| `GET /api/associates/:id/team-sales` | `Associate` (Self), `Admin` | `verifyUserToken` |
| `GET /api/associates/:id/team-sales/export` | `Associate` (Self), `Admin` | `verifyUserToken` |
| `GET /api/admin/leaderboard/team-members` | `SuperAdmin`, `FinanceManager`, `SiteManager` | `verifyAdminToken`, `role` |
| `GET /api/admin/leaderboard/team-members/export` | `SuperAdmin`, `FinanceManager`, `SiteManager` | `verifyAdminToken`, `role` |
| `GET /api/admin/leaderboard/associates` | `SuperAdmin`, `FinanceManager`, `SiteManager` | `verifyAdminToken`, `role` |
| `GET /api/admin/leaderboard/associates/export` | `SuperAdmin`, `FinanceManager`, `SiteManager` | `verifyAdminToken`, `role` |
| `GET /api/admin/leaderboard/associates/:id/drilldown`| `SuperAdmin`, `FinanceManager`, `SiteManager` | `verifyAdminToken`, `role` |
| `GET /api/admin/sales-attribution/unattributed` | `SuperAdmin`, `FinanceManager`, `SiteManager` | `verifyAdminToken`, `role` |
| `GET /api/admin/sales-attribution/export` | `SuperAdmin`, `FinanceManager`, `SiteManager` | `verifyAdminToken`, `role` |
| `PATCH /api/admin/users/:id/referrer` | `SuperAdmin`, `Admin` | `verifyAdminToken`, `role` |
| `PATCH /api/admin/bookings/:id/attribution` | `SuperAdmin` | `verifyAdminToken`, `role('SuperAdmin')` |
| `POST /api/admin/referrals/bulk-resolve` | `SuperAdmin` | `verifyAdminToken`, `role('SuperAdmin')` |
| `GET /api/profile` | Authenticated Users | `verifyUserToken` |

---

## 2. Booking Endpoints

### 2.1 `POST /api/bookings`
Primary booking creation endpoint supporting Customer Self-booking, Team Member Self/On-behalf, and Associate Self/On-behalf.

**Headers:**
```http
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

**Request Body:**
```json
{
  "plot_id": 102,
  "buyer_type": "SELF",
  "customer_id": null,
  "payment_type": "FullPayment",
  "payment_method": "Online",
  "advance_amount": 100000,
  "notes": "Booking note"
}
```
*Note on `payment_type`: Accepts both canonical and legacy terms (`FullPayment`, `OneTime`, `PartWise`, `Partial`, `DownPayment`, `EMI`, `Installment`, `Cash`).*

**Response (201 Created):**
```json
{
  "success": true,
  "message": "Booking submitted. Awaiting associate approval.",
  "data": {
    "booking_id": 35,
    "booking_serial": "MMR-2026-00035",
    "booking_status": "Submitted",
    "booking_type": "SELF_PURCHASE",
    "associate_approval_status": "Pending",
    "sold_by_user_id": 201,
    "associate_user_id": 101,
    "plot_id": 102,
    "advance_amount": 100000
  }
}
```

**Error Codes:**
- `400 Bad Request`: Missing mandatory parameters, invalid buyerType, or invalid payment format.
- `401 Unauthorized`: Token missing or expired.
- `403 Forbidden`: Customer attempting on-behalf booking, or Team Member booking for unreferred customer.
- `404 Not Found`: Plot or selected customer does not exist.
- `409 Conflict`: Plot already has an active lock, or same buyer duplicated booking.

---

### 2.2 `POST /api/team-members/bookings`
Team Member on-behalf booking delegation route.

**Request Body:**
```json
{
  "customer_id": 311,
  "plot_id": 105,
  "payment_type": "FullPayment",
  "advance_amount": 250000
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "message": "Booking created on behalf of customer. Awaiting associate approval.",
  "data": {
    "booking_id": 36,
    "booking_type": "ON_BEHALF_BY_TEAM_MEMBER",
    "associate_approval_status": "Pending",
    "sold_by_user_id": 201,
    "associate_user_id": 101
  }
}
```

---

### 2.3 `POST /api/associate/bookings`
Associate on-behalf booking delegation route. Protected by `requireAssociate`.

**Request Body:**
```json
{
  "team_member_user_id": 311,
  "plot_id": 106,
  "payment_option": "PartWise",
  "booking_amount": 200000
}
```

**Response (200 OK / 201 Created):**
```json
{
  "success": true,
  "message": "Plot booked successfully.",
  "data": {
    "booking_id": 37,
    "booking_type": "ON_BEHALF_BY_ASSOCIATE",
    "associate_approval_status": "AutoApproved_CreatedByAssociate",
    "sold_by_user_id": 201,
    "associate_user_id": 101
  }
}
```

**Error Codes:**
- `403 Forbidden`: Target customer is outside the Associate's downline network hierarchy.

---

## 3. Booking Approvals & Status Lifecycle

### 3.1 `POST /api/associate/booking-approvals/:id/approve`
Associate approves a Pending booking from their downline network.

**Headers:** `Authorization: Bearer <ASSOCIATE_TOKEN>`
**Request Body:**
```json
{
  "reason": "Documents verified and customer advance received"
}
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "Booking approved successfully. Admin may now confirm.",
  "data": {
    "booking_id": 35,
    "associate_approval_status": "Approved",
    "associate_approved_by": 101,
    "associate_approved_at": "2026-10-10T07:30:00.000Z"
  }
}
```

---

### 3.2 `POST /api/associate/booking-approvals/:id/reject`
Associate rejects a Pending booking from their downline network. Releases plot or promotes earliest waitlist.

**Request Body:**
```json
{
  "rejection_reason": "Incomplete payment documents"
}
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "Booking rejected successfully. Plot has been released or waitlist promoted.",
  "data": {
    "booking_id": 35,
    "associate_approval_status": "Rejected",
    "booking_status": "Cancelled"
  }
}
```

---

### 3.3 `POST /api/admin/bookings/:id/confirm`
Admin finalizes a booking. If `associate_approval_status = 'Pending'`, request is strictly rejected with `409 Conflict`.

**Headers:** `Authorization: Bearer <ADMIN_TOKEN>`
**Request Body:**
```json
{
  "notes": "Verified bank deposit slip"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Booking confirmed successfully.",
  "data": {
    "booking_id": 35,
    "booking_status": "Confirmed",
    "confirmed_at": "2026-10-10T07:45:00.000Z",
    "plot_status": "Booked"
  }
}
```

**Error Code (409 Conflict):**
```json
{
  "success": false,
  "message": "Cannot confirm booking: Associate approval is pending. The upline associate must approve before admin confirmation."
}
```

---

### 3.4 `POST /api/admin/bookings/:id/offline/approve`
Office offline booking verification and approval. Guarded with the identical `409 Conflict` rule if Associate approval is pending.

---

### 3.5 `POST /api/admin/bookings/:id/cancel`
Admin cancels an active booking. Executes `releasePlotOrPromoteWaitlist`:
- If waitlisted bookings exist: Promotes earliest waitlist to `Submitted`, preserves plot status as `InProcess`.
- If no waitlist exists: Reverts plot status to `Vacant`.

---

## 4. Sales Attribution & Leaderboard Reports

### 4.1 `GET /api/team-members/:id/sales-summary`
KPI metrics for Team Member dashboard.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "kpis": {
      "plots_sold": 5,
      "total_sales_value": 6500000,
      "pending_bookings": 2,
      "self_purchases_count": 1
    }
  }
}
```

---

### 4.2 `GET /api/team-members/:id/customers-sales`
Customer-aggregated sales breakdown for Team Member. Supports `?page=1&limit=20`.

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "customer_id": 311,
      "customer_name": "Ramesh Kumar",
      "customer_mobile": "9811122233",
      "plots_bought_count": 2,
      "total_sales_value": 2400000,
      "last_booking_date": "2026-10-05T10:00:00.000Z",
      "bookings": [
        { "booking_id": 12, "plot_number": "P-012", "booking_status": "Confirmed", "sale_value": 1200000 }
      ]
    }
  ]
}
```

---

### 4.3 `GET /api/associates/:id/team-sales` & `/export`
Team totals and member-wise breakdown. Protected against IDOR (Associates can only query their own team). `/export` provides formula-injection-safe CSV.

---

### 4.4 `GET /api/admin/leaderboard/team-members` & `/associates`
Rankings ordered by:
1. `plots_sold DESC`
2. `total_sales_value DESC`
3. `earliest_confirmed_sale ASC` (Tie-breaker)

Excludes self-purchases and Company Direct sales. `/export` outputs matching CSV data.

---

### 4.5 `GET /api/admin/sales-attribution/unattributed`
Audits unassigned sales. Explicitly distinguishes:
- `COMPANY_DIRECT`: Registered without referral code, direct website signup, or assigned to Company.
- `LEGACY_AMBIGUOUS`: Historical accounts where referral evidence is contradictory or missing.

---

## 5. Attribution Bulk-Resolution

### 5.1 `POST /api/admin/referrals/bulk-resolve`
Reassigns unassigned customers in bulk.

**Rules Enforced:**
- Mandatory `reason` string (rejects with 400 if missing).
- Capped at 1,000 rows per request.
- Default `dry_run: true` (validates without database write).
- Forces `referred_by_source = 'ADMIN_ASSIGNED'`.
- Rejects re-attribution of already attributed customers with `ALREADY_ATTRIBUTED` unless `override: true`.

**Request Body:**
```json
{
  "reason": "Quarterly branch audit alignment",
  "dry_run": false,
  "override": false,
  "rows": [
    {
      "customer_member_id": "MMR-CUS-00341",
      "referrer_member_id": "MMR-TM-00201"
    }
  ]
}
```

---

## 6. Profile & Referral Links

### 6.1 `GET /api/profile`
Returns unified user profile including calculated member IDs, KYC status, and personalized referral links (`https://mmrconstructions.in/register?ref=<invitation_code>`).

---

## 7. Booking Capabilities & Payment Method Governance

### 7.1 `GET /api/booking-capabilities`
Public/authenticated endpoint exposing active booking runtime policy to the frontend booking wizard.

**Response:**
```json
{
  "success": true,
  "data": {
    "booking_approval_enabled": true,
    "allow_emi_on_behalf": false,
    "allowed_payment_methods": [
      "Bank Transfer",
      "NEFT/RTGS",
      "UPI/QR",
      "Online Gateway"
    ],
    "company_bank_policy": "All plot booking payments must be deposited directly into MMR Constructions official bank accounts. Cash or Cheque deposits to agents are strictly prohibited."
  }
}
```

### 7.2 Environment Variable Controls
| Variable | Allowed Values | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `ALLOW_EMI_ON_BEHALF` | `'true'`, `'false'` | `false` | When `false`, blocks EMI payment selection on behalf of third-party customers. Returns HTTP 400. |
| `REFERRAL_INVALID_CODE_MODE` | `'reject'`, `'direct'`, `'fallback_direct'`, `'silent_company_direct'` | `'reject'` | Configures signup behavior when an unrecognized referral code is submitted. |
| `BOOKING_APPROVAL_ENABLED` | `'true'`, `'false'` | `true` | When `true`, plots booked via Team Members require upline Associate approval. |
| `DB_BACKUP_SCHEDULER_DISABLED`| `'true'`, `'false'` | `false` | Disables automated background backup cron during tests and staging scripts. |

---

## 8. Customer Attribution Management & Reassignment

### 8.1 `GET /admin/sales-attribution/unattributed`
Returns unattributed customers segmented by origin.

**Query Parameters:**
- `tab`: `'ALL'` | `'COMPANY_DIRECT'` | `'LEGACY_AMBIGUOUS'` (Default: `'ALL'`)
- `search`: Filter by name, mobile, email, or member ID.
- `page`: Page number (Default `1`).
- `limit`: Items per page (Default `25`).

### 8.2 `PATCH /api/admin/users/:id/referrer`
Manually assigns or updates a customer's referring associate/team member.

**Auth:** `SuperAdmin` or `Admin` (`verifyAdminToken`).

**Request Body:**
```json
{
  "referred_by_user_id": 42,
  "reason": "Direct walk-in attributed to Area Executive per enquiry card #8821"
}
```
*Note: `reason` is strictly mandatory. Rejects with 400 if omitted or whitespace.*

---

## 9. Staging & Production Deployment Runbook

1. **Database Migrations:**
   Run migrations idempotently before starting API process:
   ```bash
   npm run migrate:latest
   ```
2. **Environment Configuration (`.env`):**
   - Verify `ALLOW_EMI_ON_BEHALF=false`
   - Verify `REFERRAL_INVALID_CODE_MODE=reject`
   - Verify `BOOKING_APPROVAL_ENABLED=true`
   - Verify `NODE_ENV=production`
3. **Frontend Feature Flags (`src/environments/environment.prod.ts`):**
   - Confirm `features.bookingAttribution: false` until production traffic cutover.
4. **Smoke Verification Checklist:**
   - [ ] Verify `GET /api/booking-capabilities` returns `allow_emi_on_behalf: false`.
   - [ ] Confirm no "Cash" or "Cheque" options present in customer booking wizard.
   - [ ] Confirm admin booking table loads with attribution columns and associate approval badges.

