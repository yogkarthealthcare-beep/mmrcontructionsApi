# AUDIT REPORT: PLOT BOOKING PROCESS (MMR CONSTRUCTIONS ERP)

## EXECUTIVE SUMMARY
1. **Public Plot Booking:** Live on `/sites/:siteId/plot-map`. Unauthenticated users clicking "Book Now" are redirected to `/login?returnUrl=...`, and upon login/registration, return to the selected plot to submit advance booking.
2. **Booking Submission API:** `POST /api/bookings` creates records in `bookings`, calculates EMI schedule if selected, and sets `plots.plot_status = 'InProcess'`.
3. **Admin Queue & Dossier:** `BookingManagementComponent` (`/admin/booking-management`) provides search, filter by status/payment method, inspector modal, direct approval, cancellation, manual allocation, and milestone payments.
4. **Offline Booking Workflow:** `BookingWorkflowComponent` (`/admin/booking-workflow`) and `booking-workflow.routes.js` handle appointment scheduling, compliance verification, and offline approvals.
5. **Unified Payment & Receipts:** Payments sync to `payment_ledger` and generate official numbered receipts in `receipts` with PDF export.
6. **Associate Assisted Booking:** `POST /api/associate/bookings` allows associates to book plots for their downline customers with one-time or part-wise payment options.
7. **Removed / Dead Components:** The CAD Plot Detector v1/v2 tools exist as separate pages; legacy `book-plot-leads` was replaced by the Inquiries Desk and is now unrouted in the sidebar menu.
8. **Endpoint URL Mismatches:** Frontend `api.service.ts` points to legacy route names (`/approve-offline`, `/reject-offline`, `/reschedule`, `/workflow-config`, `/workflow-alerts`) which 404 against backend `booking-workflow.routes.js` endpoints (`/offline/approve`, `/offline/reject`, `/appointment`, `/booking-workflow/settings`, `/booking-workflow/alerts`).
9. **Concurrency & Timers:** There is no background cron job or `setInterval` running `releaseExpiredLocks()`; hold expiry timers only trigger on-demand when specific workflow endpoints are called.
10. **Target Process Gaps:** No separate columns for `sold_price` or `sold_at` exist in `plots` or `bookings` (they are computed/aliased on the fly), and waitlisting for multiple concurrent bookings on `InProcess` plots is not implemented.

---

## A. FEATURE INVENTORY

| Feature | Where | UI File(s) | API Endpoint(s) | DB Table(s) | State | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Customer Creates Booking Request** | Public Plot Map & Customer Portal | [`public-plot-map.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/pages/public-plot-map/public-plot-map.component.ts#L747-L830)<br>[`my-plots.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/user/my-plots/my-plots.component.ts#L67-L97) | `POST /api/bookings`<br>`POST /api/booking/initiate` | `bookings`, `plots`, `plot_booking_locks`, `emi_schedules` | **WORKING** | Supports login returnUrl and immediate InProcess plot status update |
| **Admin Booking Queue & List** | Admin Panel | [`booking-management.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/booking-management/booking-management.component.ts#L302-L318) | `GET /api/admin/bookings` | `bookings`, `plots`, `users`, `sites` | **WORKING** | Quick filters: ALL, PENDING, CONFIRMED, OFFLINE, CANCELLED |
| **Booking Detail & Dossier** | Admin Panel | [`booking-management.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/booking-management/booking-management.component.ts#L320-L334) | `GET /api/admin/bookings/:id` | `bookings`, `booking_payment_proofs`, `emi_schedules`, `plot_booking_history`, `payment_ledger` | **WORKING** | Displays 4 tabs: overview, payment proofs, EMI schedule, appointment |
| **Approve / Confirm Booking** | Admin Panel | [`booking-management.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/booking-management/booking-management.component.ts#L633-L652) | `POST /api/admin/bookings/:id/confirm`<br>`PATCH /api/admin/bookings/:id/confirm` | `bookings`, `plots`, `plot_status_history`, `audit_log` | **WORKING** | Updates plot to Booked, generates commissions, triggers user in-app notification |
| **Offline Approve / Reject** | Admin Panel | [`booking-management.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/booking-management/booking-management.component.ts#L611-L631) | `POST /api/admin/bookings/:id/approve-offline` (404)<br>`POST /api/admin/bookings/:id/offline/approve` (backend) | `bookings`, `plots`, `payment_records` | **HALF-BUILT** | Route URL mismatch between frontend `api.service.ts` and backend `booking-workflow.routes.js` |
| **Manual Plot Allocation** | Admin Panel | [`booking-management.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/booking-management/booking-management.component.ts#L433-L488) | `POST /api/admin/bookings/allocate-plot` | `bookings`, `payment_ledger`, `plots`, `inquiries` | **WORKING** | Allows admin to assign any plot directly to any customer/associate with advance payment |
| **Milestone / Partial Payment Entry** | Admin Panel | [`booking-management.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/booking-management/booking-management.component.ts#L561-L584) | `POST /api/admin/bookings/:id/record-payment` | `payment_ledger`, `bookings` | **WORKING** | Records offline/online milestone installment under verification |
| **Payment Verification & Receipts** | Admin Panel | [`booking-management.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/booking-management/booking-management.component.ts#L586-L600) | `POST /api/admin/bookings/payments/:paymentId/verify` | `payment_ledger`, `receipts`, `bookings` | **WORKING** | Approves payment in ledger, auto-generates official `MMR-REC-...` receipt |
| **EMI / Installment Schedule** | Admin & Customer | [`emi-payments.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/emi-payments/emi-payments.component.ts#L1-L80)<br>[`emi-history.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/user/emi-history/emi-history.component.ts#L1-L100) | `GET /api/emi`<br>`GET /api/admin/emi/overdue` | `emi_schedules`, `bookings`, `plots` | **WORKING** | Auto-generates monthly installments on booking confirmation |
| **Cancellation / Rejection** | Admin Panel | [`booking-management.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/booking-management/booking-management.component.ts#L726-L751) | `POST /api/admin/bookings/:id/cancel` | `bookings`, `plots`, `plot_booking_history` | **WORKING** | Reverts plot status to Vacant and notifies customer |
| **Associate Assisted Booking** | Associate Portal | [`associate.routes.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/associate/associate.routes.ts#L80-L92) | `POST /api/associate/bookings` | `bookings`, `plots`, `invoices`, `users` | **WORKING** | Associate books plot for team member; plot becomes InProcess |
| **Customer "My Bookings" Screen** | Customer Portal | [`my-plots.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/user/my-plots/my-plots.component.ts#L1-L100) | `GET /api/bookings` | `bookings`, `plots`, `sites` | **WORKING** | Displays plot card, advance paid, balance, EMI status, proof upload |
| **Invoice Viewer & PDF** | Public & Customer | [`booking-invoice.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/pages/booking-invoice/booking-invoice.component.ts#L1-L60) | `GET /api/invoice/:id`<br>`GET /api/booking/:id/invoice.pdf` | `invoices`, `booking_invoices` | **WORKING** | Dynamic QR code, barcode, printable invoice |
| **Booking Report / Leads** | Admin Panel | [`booking-report.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/booking-report/booking-report.component.ts#L1-L100) | `GET /api/admin/inquiries` | `inquiries` | **WORKING** | Categorized into Customer, Associate, Investor, Site Visit leads |
| **Legacy Book Plot Leads** | Admin Panel | [`book-plot-leads.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/book-plot-leads/book-plot-leads.component.ts#L1-L80) | `GET /api/book-plot/leads` | `book_plot_leads` | **HIDDEN** | Exists and routed in `admin.routes.ts`, but removed from primary sidebar navigation |
| **Plot Booking Process Dashboard** | Admin Panel | [`plot-booking-process.component.ts`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/admin/plot-booking-process/plot-booking-process.component.ts#L1-L185) | None (Hub Component) | N/A | **WORKING** | ERP navigation hub linking site master, CAD detector, editor, inquiries, and customer applications |
| **Registry / Sale Completion (Sold)** | Admin Panel / DB | [`registry_records` table](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/database_tables_schema.txt#L1769-L1788) | `PUT /api/admin/plots/:id/status` | `registry_records`, `plots` | **HALF-BUILT** | Admin can manually set plot status to 'Sold', but registry record form UI is not linked in booking management |
| **Hold Expiry Background Scheduler** | Backend Cron | `services/databaseBackup.service.js` | None | `plot_booking_locks` | **NOT FOUND** | Expiry only runs on-demand during specific HTTP requests; no background worker |

---

## B. BOOKING LIFECYCLE AS IMPLEMENTED

### 1. Status Transitions & Triggers

```
                         [ Customer Books Unit ]
                          (Public Map / Portal)
                                   │
                                   ▼
             ┌───────────────────────────────────────────┐
             │            plot_status: InProcess         │
             │           booking_status: Submitted       │
             └─────────────────────┬─────────────────────┘
                                   │
                 ┌─────────────────┴─────────────────┐
                 │                                   │
         [ Admin Confirms /                  [ Admin Cancels /
          Verifies Advance ]                  Payment Rejection ]
                 │                                   │
                 ▼                                   ▼
   ┌───────────────────────────┐       ┌───────────────────────────┐
   │    plot_status: Booked    │       │    plot_status: Vacant    │
   │  booking_status: Confirmed│       │  booking_status: Cancelled│
   └─────────────┬─────────────┘       └───────────────────────────┘
                 │
      [ Full Payment Received /
        Manual Registry Update ]
                 │
                 ▼
   ┌───────────────────────────┐
   │     plot_status: Sold     │
   │ booking_status: Fully Paid│
   └───────────────────────────┘
```

### 2. Every Location Where `plot_status` is Written

1. **`server.js:6500`** (Customer `POST /api/bookings`):
```javascript
// Mark plot InProcess immediately so public availability updates on refresh.
await sql`UPDATE plots SET plot_status = 'InProcess', updated_at = NOW() WHERE plot_id = ${plot_id}`;
```

2. **`server.js:8179`** (Associate `POST /api/associate/bookings`):
```javascript
// Reserve Plot Status to InProcess
await sql`UPDATE plots SET plot_status = 'InProcess', updated_at = NOW() WHERE plot_id = ${plot.plot_id}`;
```

3. **`server.js:10075` & `server.js:10194`** (Admin Confirm `POST /api/admin/bookings/:id/confirm`):
```javascript
await sql`UPDATE plots SET plot_status = 'Booked', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;
```

4. **`server.js:10139` & `server.js:10248`** (Admin Cancel `POST /api/admin/bookings/:id/cancel`):
```javascript
await sql`UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;
```

5. **`server.js:11926`** (Admin Status Override `PUT /api/admin/plots/:id/status`):
```javascript
await sql`UPDATE plots SET plot_status = ${new_status}::plot_status_enum, updated_at = NOW() WHERE plot_id = ${req.params.id}`;
```

6. **`routes/booking-workflow.routes.js:86`** (`releaseExpiredLocks` function):
```javascript
await db`
  UPDATE plots p SET plot_status = 'Vacant', updated_at = NOW()
  WHERE p.plot_id = ${lock.plot_id}
    AND p.plot_status = 'InProcess'
    AND NOT EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.plot_id = p.plot_id AND b.booking_status IN ('PaymentPending','Confirmed')
    )`;
```

7. **`routes/booking-workflow.routes.js:313`** (`completeBooking` function):
```javascript
await db`UPDATE plots SET plot_status = 'Booked', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;
```

8. **`routes/booking-workflow.routes.js:455`** (`POST /booking/initiate`):
```javascript
await db`UPDATE plots SET plot_status = 'InProcess', updated_at = NOW() WHERE plot_id = ${plotId}`;
```

9. **`routes/booking-workflow.routes.js:766`** (`POST /admin/bookings/:id/offline/reject`):
```javascript
await db`UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;
```

10. **`routes/booking-workflow.routes.js:923`** (`POST /admin/bookings/allocate-plot`):
```javascript
if (matchedPlotId && matchedPlot.plot_status === 'Vacant') {
  await db`UPDATE plots SET plot_status = 'Booked', updated_at = NOW() WHERE plot_id = ${matchedPlotId}`;
}
```

---

## C. DATABASE SCHEMA & STORAGE AUDIT

### 1. Key Table Schemas

#### A. Table `plots` ([`database_tables_schema.txt:1674-1696`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/database_tables_schema.txt#L1674-L1696))
- `plot_id` (PK integer)
- `site_id` (FK integer)
- `plot_number` (varchar)
- `plot_area` (numeric, stored in Gaj)
- `plot_category` (enum: 'Residential', 'Commercial', 'Industrial')
- `unit_type` (varchar: 'PLOT', 'VILLA', 'SHOP', 'HOSPITAL', 'MALL', etc.)
- `base_price` (numeric)
- `down_payment` (numeric)
- `monthly_emi` (numeric)
- `emi_tenure_months` (integer, default 60)
- `plot_status` (enum: 'Vacant', 'InProcess', 'Booked', 'Sold')
- `is_active` (boolean, default true)

#### B. Table `bookings` ([`database_tables_schema.txt:352-384`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/database_tables_schema.txt#L352-L384))
- `booking_id` (PK integer)
- `booking_serial` (varchar, format `MMR-YYYY-XXXXX`)
- `user_id` (FK integer to `users`)
- `plot_id` (FK integer to `plots`, nullable for manual text allocations)
- `site_id` (integer)
- `plot_number` (varchar, manual plot number text support)
- `booking_date` (timestamptz, default now())
- `payment_type` (varchar / enum: 'FullPayment', 'EMI', 'DownPayment', 'Cash', 'Online')
- `advance_amount` (numeric)
- `booking_status` (varchar / enum: 'Submitted', 'PaymentPending', 'Allocated', 'Confirmed', 'Cancelled')
- `workflow_status` (varchar: 'Booking Initiated', 'Plot Allocated by Admin', 'Fully Paid', 'Partially Paid')
- `required_booking_amount` (numeric)
- `remaining_balance` (numeric)
- `confirmed_by_admin_id` (FK integer)
- `confirmed_at` (timestamptz)
- `cancellation_reason` (text)
- `cancelled_by_admin_id` (FK integer)
- `cancelled_at` (timestamptz)

#### C. Table `payment_ledger` ([`unifiedPaymentSchema.service.js:14-51`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructionsApi/services/unifiedPaymentSchema.service.js#L14-L51))
- `payment_id` (PK bigserial)
- `payment_serial` (varchar unique `PL-YYYYMMDD-XXXXXX`)
- `user_id` (bigint)
- `booking_id` (bigint)
- `plot_id` (bigint)
- `site_id` (bigint)
- `payment_mode` (varchar: 'Online', 'Cash', 'Cheque', 'BankTransfer', 'UPI', 'Wallet')
- `payment_purpose` (varchar: 'BookingAdvance', 'EmiPayment', 'PartPayment', 'FullPayment')
- `gross_amount` (numeric)
- `payment_status` ('Initiated', 'Submitted', 'UnderVerification', 'Approved', 'Rejected')
- `verification_status` ('Pending', 'Verified', 'Rejected')
- `receipt_id` (bigint FK to `receipts`)

#### D. Table `receipts` ([`20260914000000_create_receipts_table.js:9-41`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructionsApi/migrations/20260914000000_create_receipts_table.js#L9-L41))
- `id` (PK bigserial)
- `receipt_no` (varchar unique `MMR-REC-YYYY-XXXXX`)
- `customer_id` (bigint)
- `customer_name` (varchar)
- `mobile_no` (varchar)
- `plot_no` (varchar)
- `receipt_date` (date)
- `payment_mode` (varchar)
- `receipt_amount` (numeric)
- `paid_amount` (numeric)
- `is_locked` (boolean, default true)

#### E. Table `plot_status_history` ([`database_tables_schema.txt:1659-1671`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/database_tables_schema.txt#L1659-L1671))
- `history_id` (PK integer)
- `plot_id` (integer)
- `old_status` (enum `plot_status_enum`)
- `new_status` (enum `plot_status_enum`)
- `changed_by_admin_id` (integer)
- `reason` (varchar)
- `changed_at` (timestamptz)

#### F. Table `registry_records` ([`database_tables_schema.txt:1769-1788`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/database_tables_schema.txt#L1769-L1788))
- `registry_id` (PK integer)
- `booking_id` (integer)
- `user_id` (integer)
- `plot_id` (integer)
- `registry_status` (enum: 'Pending', 'In Progress', 'Completed')
- `mutation_date` (date)
- `registry_date` (date)
- `possession_date` (date)
- `document_path` (varchar)

### 2. Specific Data Location Answers

| Required Data Point | Stored In Table | Exact Column(s) | Notes |
| :--- | :--- | :--- | :--- |
| **Customer Identification** | `bookings`, `users` | `bookings.user_id`, `users.full_name`, `users.mobile_no` | Joined on `user_id` |
| **Plot Information** | `bookings`, `plots` | `bookings.plot_id`, `bookings.plot_number`, `plots.plot_number` | Supports foreign key or manual text fallback |
| **Booking Date** | `bookings` | `bookings.booking_date` or `bookings.created_at` | Timestamptz |
| **Advance / Token Amount** | `bookings`, `payment_ledger` | `bookings.advance_amount`, `payment_ledger.gross_amount` | Captured upon initiation |
| **Total / Base Price** | `plots`, `bookings` | `plots.base_price`, `bookings.base_price` | Numeric |
| **Sold Price** | **NOT STORED AS DIRECT COLUMN** | Aliased dynamically as `COALESCE(b.advance_amount, p.base_price)` | Calculated in `GET /api/public/sites/:id/plot-map` |
| **Sold Date** | **NOT STORED AS DIRECT COLUMN** | Aliased dynamically as `COALESCE(b.created_at, p.updated_at)` | Calculated in `GET /api/public/sites/:id/plot-map` |
| **Payment Mode** | `bookings`, `payment_ledger` | `bookings.payment_method`, `payment_ledger.payment_mode` | 'Cash', 'Online', 'Cheque', 'BankTransfer' |
| **Installment Plan** | `emi_schedules` | `emi_schedules.installment_no`, `due_date`, `emi_amount` | Multi-row table per booking |
| **Associate Linkage** | `users`, `invoices`, `referral_registrations` | `users.sponsor_user_id`, `invoices.associate_id` | Mapped via user sponsor tree |
| **Booking Status History** | `plot_booking_history`, `plot_status_history` | `plot_booking_history.event_type`, `plot_status_history.new_status` | Comprehensive audit trail |

---

## D. API CONTRACT AUDIT

### 1. Booking & Plot Workflow Endpoints

| Method & Endpoint | Auth Middleware | Request Payload | Response Shape | Side Effects | Called by Frontend? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `POST /api/bookings` | `verifyUserToken` | `{ plot_id, payment_type, advance_amount, notes }` | `{ success: true, message, data: { booking_id, booking_serial, booking_status } }` | Sets `plot_status='InProcess'`, inserts `emi_schedules`, sends notification | **YES** (`public-plot-map.component.ts:770`) |
| `GET /api/admin/bookings` | `verifyAdminToken` | Query: `status, site_id, payment_status, search, page, limit` | `{ success: true, data: [ BookingListItem ] }` | None (Read-only) | **YES** (`booking-management.component.ts:304`) |
| `GET /api/admin/bookings/:id` | `verifyAdminToken` | Params: `:id` | `{ success: true, data: { ...booking, customer, plot, site, emi_schedule, history, payments } }` | None (Read-only) | **YES** (`booking-management.component.ts:325`) |
| `POST /api/admin/bookings/:id/confirm` | `verifyAdminToken` + `role('SuperAdmin', 'SiteManager', 'FinanceManager')` | `{ notes }` | `{ success: true, message: 'Booking confirmed.' }` | Sets `plots.plot_status='Booked'`, `bookings.booking_status='Confirmed'`, computes MLM commission | **YES** (`booking-management.component.ts:641`) |
| `POST /api/admin/bookings/:id/cancel` | `verifyAdminToken` + `role('SuperAdmin', 'SiteManager', 'FinanceManager')` | `{ reason }` | `{ success: true, message: 'Booking cancelled. Plot set to Vacant.' }` | Sets `plots.plot_status='Vacant'`, `bookings.booking_status='Cancelled'`, notifies user | **YES** (`booking-management.component.ts:738`) |
| `POST /api/admin/bookings/allocate-plot` | `verifyAdminToken` | `{ user_id, site_id, plot_number, total_price, initial_payment_amount, payment_mode, payment_reference, remarks }` | `{ success: true, data: { booking, payment, plot_number, site_name } }` | Creates `bookings`, `payment_ledger`, sets matched plot to 'Booked', auto-generates EMI schedule | **YES** (`booking-management.component.ts:463`) |
| `POST /api/admin/bookings/:id/record-payment` | `verifyAdminToken` | `{ received_amount, payment_mode, payment_reference, payment_date, remarks }` | `{ success: true, data: payment_ledger_row }` | Inserts `payment_ledger` record with status 'UnderVerification' | **YES** (`booking-management.component.ts:566`) |
| `POST /api/admin/bookings/payments/:paymentId/verify` | `verifyAdminToken` | Params: `:paymentId` | `{ success: true, data: { payment_id, total_approved, remaining_balance, is_fully_paid } }` | Updates ledger to 'Approved', generates receipt in `receipts`, updates remaining balance | **YES** (`booking-management.component.ts:589`) |
| `PUT /api/admin/plots/:id/status` | `verifyAdminToken` + `role('SuperAdmin', 'SiteManager')` | `{ new_status, reason }` | `{ success: true, message: 'Plot status updated' }` | Updates `plots.plot_status`, inserts `plot_status_history` and `plot_booking_history` | **YES** (`booking-management.component.ts:762`) |
| `GET /api/public/sites/:id/plot-map` | `publicApiLimiter` | Params: `:id` | `{ success: true, data: { site, plots: [ { plot_id, plot_number, unit_type, public_status, area_sqft, area_gaj, price, sold_price, sold_at, polygon_coordinates } ] } }` | None (Read-only public API) | **YES** (`public-plot-map.component.ts:160`) |
| `POST /api/associate/bookings` | `verifyUserToken` + `requireAssociate` | `{ team_member_user_id, plot_id, payment_option, booking_amount, payment_method, notes }` | `{ success: true, data: { booking_id, booking_serial, invoice_number } }` | Verifies downline, sets `plots.plot_status='InProcess'`, creates invoice | **YES** (`api.service.ts:243`) |
| `POST /api/admin/bookings/:id/offline/approve` | `adminAuth` | `{ reference_no, remarks }` | `{ success: true, data: { booking_id, commission } }` | Sets `plot_status='Booked'`, `booking_status='Confirmed'`, completes invoice | **NO (URL Mismatch)**: Frontend calls `/approve-offline` |
| `POST /api/admin/bookings/:id/offline/reject` | `adminAuth` | `{ reason }` | `{ success: true, message: 'Offline payment rejected and plot released.' }` | Sets `plot_status='Vacant'`, `booking_status='Cancelled'`, releases locks | **NO (URL Mismatch)**: Frontend calls `/reject-offline` |

---

## E. CONCURRENCY & BUSINESS RULES

### 1. What happens if a plot is already `InProcess` and another customer books it?
- In `server.js:6458-6459`, only `Booked` and `Sold` statuses are blocked:
```javascript
// File: mmrconstructionsApi/server.js (Lines 6458-6459)
if (plot.plot_status === "Booked" || plot.plot_status === "Sold")
  return err(res, "This plot is already booked or sold and no longer available.", 409);
```
- **Result:** If a plot is `InProcess`, a second customer is permitted to submit a booking request. Both bookings will be in status `Submitted` with the plot remaining `InProcess`. The admin decides which booking to confirm/verify first.

### 2. What happens if two customers book at the exact same moment?
- In `routes/booking-workflow.routes.js:424`:
```javascript
// File: mmrconstructionsApi/routes/booking-workflow.routes.js (Lines 424-430)
await db`SELECT pg_advisory_xact_lock(${plotId})`;
await releaseExpiredLocks(db);
const [plot] = await db`
  SELECT p.*, s.site_name
  FROM plots p JOIN sites s ON s.site_id = p.site_id
  WHERE p.plot_id = ${plotId}
  FOR UPDATE`;
```
- **Result:** In `booking-workflow.routes.js`, Postgres transaction advisory lock `pg_advisory_xact_lock(plotId)` and row-level lock `FOR UPDATE` serialize concurrent requests. However, in `server.js:6431` (`POST /api/bookings`), there is no table/row lock, allowing parallel rows in `bookings`.

### 3. What happens if a plot is `Booked` or `Sold`?
- Both `server.js` and `booking-workflow.routes.js` immediately throw a 409 Conflict error:
```javascript
// File: mmrconstructionsApi/server.js (Line 6459)
if (plot.plot_status === "Booked" || plot.plot_status === "Sold")
  return err(res, "This plot is already booked or sold and no longer available.", 409);
```

### 4. What happens if advance is never paid (Hold Expiry)?
- `plot_booking_locks` stores an `expires_at` timestamp.
- However, `releaseExpiredLocks()` is only executed when an API endpoint inside `booking-workflow.routes.js` is triggered:
```javascript
// File: mmrconstructionsApi/routes/booking-workflow.routes.js (Lines 79-94)
async function releaseExpiredLocks(db = sql) {
  const expired = await db`
    UPDATE plot_booking_locks
    SET status = 'Expired', updated_at = NOW()
    WHERE status = 'Active' AND expires_at <= NOW()
    RETURNING plot_id`;
  for (const lock of expired) {
    await db`
      UPDATE plots p SET plot_status = 'Vacant', updated_at = NOW()
      WHERE p.plot_id = ${lock.plot_id}
        AND p.plot_status = 'InProcess'
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.plot_id = p.plot_id AND b.booking_status IN ('PaymentPending','Confirmed')
        )`;
  }
}
```
- **Result:** There is NO standalone timer or background cron process. If no user hits those specific endpoints, the expired lock will remain in the database until the next trigger.

### 5. What happens when a booking is cancelled?
- In `server.js:10139` and `booking-workflow.routes.js:766`:
```javascript
// File: mmrconstructionsApi/server.js (Lines 10137-10139)
WHERE booking_id = ${req.params.id}`;
await sql`UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;
```
- **Result:** The plot status is immediately reset to `'Vacant'`, and an entry is logged in `plot_booking_history`.

---

## F. REMOVED & DEAD CODE REPORT

1. **CAD Plot Detector v1 & v2 Re-architected into Tools:**
   - **Commit `65c3b59`** (`feat: add CAD/DXF plot detector tool, unified plot status styles`): The earlier inline map detector inside the booking wizard was extracted into separate standalone admin tools (`/admin/plot-detector-tool` and `/admin/plot-detector-2`).
   - **Status Today:** Files exist and are reachable under "PROPERTY & SITES".

2. **Legacy `book-plot-leads` Component Unlinked from Sidebar:**
   - **Commit `664c185`** (`Restructure Admin Panel sidebar menu`): Removed `/admin/book-plot-leads` from `rawNavGroups` in `layout.component.ts`.
   - **Status Today:** Replaced by `/admin/booking-report` (Inquiries Desk). The component file `src/app/admin/book-plot-leads/book-plot-leads.component.ts` remains in the tree and can still be accessed directly or via the `PlotBookingProcessComponent` dashboard card.

3. **Master Property & Plot Tools Toggle:**
   - **Commit `234df20` / `fd17514`**: Added a master toggle in the admin topbar and sidebar navigation to show/hide plot tools.
   - **Status Today:** Toggle state is stored in `SiteToggleService` with default `true`.

4. **URL Discrepancies in `api.service.ts`:**
   - The following frontend methods call endpoints that were refactored in `booking-workflow.routes.js`:
     - `adminApproveOfflineBooking` calls `POST /api/admin/bookings/:id/approve-offline` (Backend is `/offline/approve`)
     - `adminRejectOfflineBooking` calls `POST /api/admin/bookings/:id/reject-offline` (Backend is `/offline/reject`)
     - `adminRescheduleAppointment` calls `POST /api/admin/bookings/:id/reschedule` (Backend is `PATCH /appointment`)
     - `adminGetBookingWorkflowSettings` calls `GET /api/admin/booking/workflow-config` (Backend is `/booking-workflow/settings`)
     - `adminGetWorkflowAlerts` calls `GET /api/admin/booking/workflow-alerts` (Backend is `/booking-workflow/alerts`)
   - **Difficulty to Fix / Restore:** Minimal (10-line alignment in `api.service.ts` or alias routes in backend).

---

## G. CUSTOMER & ASSOCIATE SIDE CAPABILITIES

### 1. Customer (`/customer/*` or `/user/*`)
- **Route Guard:** Protected by `customerGuard` and `enrollmentGuard` ([`app.routes.ts:211-218`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/app.routes.ts#L211-L218)).
- **My Plots / Bookings (`/customer/my-plots`):**
  - View all booked/allocated plots with site name, plot number, size (Sq.Yd. / Sq.Ft.), base price, advance amount paid, and remaining balance.
  - Upload payment proof files (UPI screenshot, bank deposit slip).
  - Apply for 2-year guaranteed buyback (`/customer/buyback`).
- **EMI History (`/customer/emi-history`):**
  - View full breakdown of installments, due dates, late fees, paid status, and pay EMI online via Razorpay/Wallet.
- **Payment History (`/customer/payments`):**
  - Unified multi-stream payment ledger showing confirmed deposits and downloadable receipts.
- **Invoices (`/customer/invoice/:id`):**
  - View, print, and download PDF invoice with QR code verification.

### 2. Associate (`/associate/*`)
- **Route Guard:** Protected by `associateGuard` and `enrollmentGuard` ([`app.routes.ts:202-209`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/app.routes.ts#L202-L209)).
- **Team Member Plot Booking (`/associate/team-member-enrollment` & `POST /api/associate/bookings`):**
  - Select customer from their authorized downline team.
  - Select active project site and vacant plot.
  - Submit booking with One-Time or Part-Wise advance payment.
- **Commission Tracker (`/associate/commission`):**
  - Track level-wise and direct commissions earned from team member plot sales.
- **Network Tree (`/associate/network-tree`):**
  - Visual genealogy tree of downline team members.

### 3. Login Redirection & returnUrl Flow
- When an unauthenticated user clicks "Book Now" on `/sites/:siteId/plot-map`, [`PublicPlotMapComponent`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/pages/public-plot-map/public-plot-map.component.ts#L718-L720) builds:
  `returnUrl = '/sites/' + siteId + '/plot-map?plot=' + plotId + '&book=1'`
- [`LoginComponent`](file:///d:/ClientsData/MMRConstructions/mmrconstructions-main/mmrconstructions-main/src/app/pages/login/login.component.ts#L125-L130) intercepts `returnUrl` and redirects the user back to the exact plot map after authentication.
- `PublicPlotMapComponent.handleQueryParamPlotSelection()` detects `plot` and `book=1` parameters, selects and centers the plot, and opens the booking confirmation dialog automatically.

---

## H. GAP ANALYSIS AGAINST TARGET PROCESS

| Target Requirement | Implementation Status | What Exists Today | What is Missing | Action Required |
| :--- | :--- | :--- | :--- | :--- |
| **1. Public Plot Map Booking & Login Redirect** | **EXISTS** | `PublicPlotMapComponent` with `returnUrl`, URL query param auto-selection, and booking modal | None; working end-to-end | None |
| **2. Booking Request & Plot Vacant -> InProcess** | **EXISTS** | `POST /api/bookings` updates `plots.plot_status = 'InProcess'` and creates `bookings` record | Concurrency advisory lock missing in `server.js` | Add `pg_advisory_xact_lock` to `POST /api/bookings` in `server.js` (Est: 15 mins) |
| **3. Admin Booking Queue & Advance Verification -> Booked** | **EXISTS** | `BookingManagementComponent` filters by site, date, status, verifies advance, updates plot to `Booked` | Minor route name mismatches for offline approve/reject buttons | Update 4 endpoint URLs in `api.service.ts` to match `booking-workflow.routes.js` (Est: 10 mins) |
| **4. Sold Out State with Sold Price + Sold Date (No Buyer Info)** | **PARTIAL** | `GET /api/public/sites/:id/plot-map` returns `sold_price` and `sold_at` for `SOLD_OUT` units without buyer details | `sold_price` and `sold_date` columns do not exist in `plots` table; currently computed from bookings | Add `sold_price NUMERIC(14,2)` and `sold_date TIMESTAMPTZ` columns to `plots` table and save on final payment (Est: 30 mins) |
| **5. Cancellation & Safe Multi-Booking Resolution** | **PARTIAL** | Cancel resets plot to `Vacant` and logs history; multiple bookings on `InProcess` plots can be created | When Admin confirms 1st booking, other pending bookings on that plot are not automatically waitlisted/notified | Add auto-rejection/waitlisting hook in `confirmBooking` for overlapping pending bookings (Est: 25 mins) |
| **6. Hold Expiry Background Timer & Status Notifications** | **PARTIAL** | In-app notifications are sent on Submit, Confirm, Cancel; lock table exists | No background cron runs `releaseExpiredLocks()`; hold timer only checks on HTTP request | Add `setInterval` cron worker in backend to auto-expire unpaid `InProcess` locks every 5 mins (Est: 20 mins) |

---

## I. RISKS, SECURITY CONCERNS & QUESTIONS BEFORE BUILDING

### 1. Security & Concurrency Risks
- **No DB Transaction on Public Booking Submission:** `POST /api/bookings` in `server.js` does not use `sql.begin(...)` or `pg_advisory_xact_lock`. If two users submit simultaneously, both insert into `bookings` without locking.
- **URL Discrepancies in API Service:** Frontend `api.service.ts` uses `/approve-offline`, `/reject-offline`, `/reschedule`, `/workflow-config`, and `/workflow-alerts` which will return HTTP 404 against `booking-workflow.routes.js`.
- **Public Data Privacy:** Public plot map endpoint correctly excludes buyer identity (`user_id`, customer name, phone), only returning `plot_number`, `unit_type`, `area_sqft`, `sold_price`, and `sold_at`.

### 2. Questions to Confirm Before Phase 2 Implementation
1. **Hold Duration Policy:** Should unpaid `InProcess` plots auto-expire back to `Vacant` after **20 minutes** (online lock) or **48 hours** (offline booking), or a configurable setting?
2. **Multiple Bookings on InProcess Unit:** If Plot #12 is `InProcess` and Customer B also submits a booking, should Customer B be shown a "Waitlisted / Queue Position #2" badge, or should `InProcess` plots be strictly disabled for second bookings?
3. **Registry Record Entry:** When an admin marks a plot as `Sold`, should a modal prompt for registry deed number, possession date, and final sold amount to populate `registry_records`?
