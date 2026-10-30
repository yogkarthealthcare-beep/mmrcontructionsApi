/**
 * MMR Construction & Developers Pvt. Ltd.
 * Shared Booking Service (Phase 2 Centralized Core)
 *
 * Implements:
 * 1. Strict server-side attribution derivation (JWT-independent fresh DB actor fetch)
 * 2. Actor-based permissions & 403 enforcement
 * 3. Atomic transaction with pg_advisory_xact_lock(plot_id) + SELECT FOR UPDATE
 * 4. Multi-application preservation on Vacant/InProcess plots + duplicate buyer 409 guard
 * 5. Plot availability checks (Booked/Sold -> 409)
 * 6. Audit logging & plot status history synchronization
 */

import sql from '../db.js';
import { bookingApprovalConfig } from '../config/bookingApproval.js';
import installmentService from './installmentService.js';
import { ensureSalesAttributionSchema } from './salesAttributionSchema.service.js';

let bookingTableSchemaEnsured = false;

/**
 * Proactively ensure bookings table schema and all required columns exist
 * prior to any booking creation, waitlist query, or transaction.
 */
export async function ensureBookingTableSchema(db = sql) {
  if (bookingTableSchemaEnsured) return;
  try {
    if (typeof ensureSalesAttributionSchema === 'function') {
      await ensureSalesAttributionSchema(db).catch(() => {});
    }
    await db.unsafe(`
      CREATE TABLE IF NOT EXISTS booking_workflow_settings (
        id INT PRIMARY KEY DEFAULT 1,
        part_wise_deadline_months INT DEFAULT 3,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by_admin_id INT
      );
      INSERT INTO booking_workflow_settings (id, part_wise_deadline_months) VALUES (1, 3) ON CONFLICT (id) DO NOTHING;

      ALTER TABLE booking_workflow_settings ADD COLUMN IF NOT EXISTS min_plot_price NUMERIC(14,2) DEFAULT 200000;
      ALTER TABLE booking_workflow_settings ADD COLUMN IF NOT EXISTS reference_rate_per_gaj NUMERIC(14,2) DEFAULT 8000;
      ALTER TABLE booking_workflow_settings ADD COLUMN IF NOT EXISTS min_emi_down_payment NUMERIC(14,2) DEFAULT 30000;
      ALTER TABLE booking_workflow_settings ADD COLUMN IF NOT EXISTS part_wise_gap_days INT DEFAULT 7;
      ALTER TABLE booking_workflow_settings ADD COLUMN IF NOT EXISTS part_wise_installments INT DEFAULT 4;
      ALTER TABLE booking_workflow_settings ADD COLUMN IF NOT EXISTS part_wise_first_percent NUMERIC(5,2) DEFAULT 25.00;
      ALTER TABLE booking_workflow_settings ADD COLUMN IF NOT EXISTS part_wise_deadline_months INT DEFAULT 3;
      ALTER TABLE booking_workflow_settings ADD COLUMN IF NOT EXISTS approval_chain_enabled BOOLEAN DEFAULT FALSE;
      ALTER TABLE booking_workflow_settings ADD COLUMN IF NOT EXISTS auto_reject_after_hours INT DEFAULT 72;
      ALTER TABLE booking_workflow_settings ADD COLUMN IF NOT EXISTS max_active_requests_per_user INT DEFAULT 5;

      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS queue_position INTEGER DEFAULT 1;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(100) DEFAULT 'Cash / Bank';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS required_booking_amount NUMERIC(14,2) DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS installment_plan_id INTEGER;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS plan_snapshot JSONB;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS part_wise_deadline_at TIMESTAMPTZ;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_due BOOLEAN DEFAULT FALSE;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_reason TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_marked_at TIMESTAMPTZ;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_marked_by_admin_id INTEGER;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booked_by_user_id INTEGER;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sold_by_user_id INTEGER;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_user_id INTEGER;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_type VARCHAR(40) NOT NULL DEFAULT 'CUSTOMER_SELF';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_approval_status VARCHAR(40) NOT NULL DEFAULT 'NotRequired';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_approved_by INTEGER;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_approved_at TIMESTAMPTZ;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_rejection_reason TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_approval_overridden BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS workflow_status VARCHAR(80) DEFAULT 'Booking Initiated';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS base_price NUMERIC(14,2) DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS advance_amount NUMERIC(14,2) DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC(14,2) DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_date TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_type VARCHAR(50) DEFAULT 'FullPayment';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS list_price NUMERIC(14,2);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_overridden BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_set_by_user_id INTEGER;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS requested_price NUMERIC(14,2);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_approval_status VARCHAR(50);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_approved_by INTEGER;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_approved_at TIMESTAMPTZ;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_admin_counter NUMERIC(14,2);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_rejection_reason TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS plot_area NUMERIC(14,2) DEFAULT NULL;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS area_unit VARCHAR(50) DEFAULT NULL;

      CREATE TABLE IF NOT EXISTS plot_price_history (
        id SERIAL PRIMARY KEY,
        plot_id INTEGER NOT NULL,
        old_price NUMERIC(14,2) NULL,
        new_price NUMERIC(14,2) NOT NULL,
        rate_per_gaj NUMERIC(14,2) NULL,
        rate_per_sqft NUMERIC(14,2) NULL,
        changed_by_admin_id INTEGER NULL,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source VARCHAR(50) NOT NULL DEFAULT 'MANUAL_EDIT'
      );

      CREATE INDEX IF NOT EXISTS idx_bookings_queue_position ON bookings(queue_position);
      CREATE INDEX IF NOT EXISTS idx_bookings_plot_id ON bookings(plot_id);
      CREATE INDEX IF NOT EXISTS idx_plot_price_history_plot_id ON plot_price_history(plot_id);

      DO $$
      BEGIN
        BEGIN
          ALTER TABLE audit_log ALTER COLUMN actor_type TYPE VARCHAR(100);
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END $$;
    `);
    bookingTableSchemaEnsured = true;
  } catch (err) {
    console.warn('[BookingService] ensureBookingTableSchema notice:', err.message);
  }
}

/**
 * Custom Error helper with HTTP status code
 */
export function createBookingError(message, status = 400, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  Object.assign(err, extra);
  return err;
}

/**
 * Resolve Associate ID for a seller/user using database function or fallback query
 */
export async function resolveAssociate(db, userId) {
  if (!userId) return null;
  try {
    const [res] = await db`SELECT fn_resolve_associate(${userId}::INT) AS assoc_id`;
    if (res?.assoc_id) return Number(res.assoc_id);
  } catch (e) {
    // Fallback if SQL function not available
  }

  const [user] = await db`SELECT user_id, user_type, sponsor_user_id FROM users WHERE user_id = ${userId}`;
  if (!user) return null;
  if (user.user_type === 'Associate') return user.user_id;
  if (user.user_type === 'Team Member') {
    const [tm] = await db`
      SELECT associate_id FROM team_members 
      WHERE user_id = ${userId} AND status IN ('approved', 'active', 'pending')
      ORDER BY created_at DESC LIMIT 1
    `;
    if (tm?.associate_id) return Number(tm.associate_id);
    return user.sponsor_user_id || null;
  }
  return null;
}

/**
 * Record an entry into the centralized audit log
 */
export async function recordBookingAudit(db, {
  bookingId,
  action,
  actorId,
  actorType = 'User',
  actorName = null,
  beforeState = null,
  afterState = null,
  reason = null,
  isOverride = false
}) {
  try {
    const details = {
      booking_id: bookingId,
      action,
      before: beforeState,
      after: afterState,
      reason,
      is_override: isOverride,
      actor_role: actorType,
      timestamp: new Date().toISOString()
    };

    // Normalize actorType to match actor_type_enum ('Admin', 'User', 'System')
    let safeActorType = 'User';
    const rawType = String(actorType || '').trim().toLowerCase();
    if (rawType.includes('admin') || rawType === 'superadmin') {
      safeActorType = 'Admin';
    } else if (rawType.includes('system')) {
      safeActorType = 'System';
    } else {
      safeActorType = 'User';
    }

    const doInsert = async (executor) => {
      await executor`
        INSERT INTO audit_log (
          actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value
        ) VALUES (
          ${safeActorType}, ${actorId}, ${actorName}, 'Bookings', ${action}, 'bookings', ${bookingId}, ${JSON.stringify(details)}
        )
      `;
    };

    if (db && typeof db.savepoint === 'function') {
      await db.savepoint(doInsert);
    } else {
      await doInsert(db || sql);
    }
  } catch (err) {
    console.warn('[Booking Audit Warning]:', err?.message);
  }
}

/**
 * Core createBooking implementation
 */
export async function createBooking({
  actor,
  actorId = null,
  buyerType = 'SELF', // 'SELF' | 'CUSTOMER'
  customerId = null,
  plotId,
  siteId = null,
  paymentType = 'FullPayment',
  paymentOption = null, // legacy alias
  advanceAmount = 0,
  bookingAmount = null, // legacy alias
  paymentMethod = 'Online',
  notes = '',
  workflowStatus = null,
  bookingStatus = null,
  requiredBookingAmount = null,
  minimumBookingAmount = null,
  firstEmiAmount = null,
  lockMinutes = null,
  installmentPlanId = null,
  installment_plan_id = null,
  customDb = null,
  customPlotPrice = null,
  custom_plot_price = null,
  plotPrice: incomingPlotPrice = null,
  plot_price = null,
  base_price = null,
  plotArea = null,
  plot_area = null,
  areaUnit = null,
  area_unit = null
}) {
  const runner = customDb || sql;
  await ensureBookingTableSchema(runner);

  // 1. Resolve fresh Actor from Database (never rely solely on JWT token claims)
  const resolvedActorId = Number(actor?.user_id || actorId);
  if (!resolvedActorId) {
    throw createBookingError('Actor identification is required.', 401);
  }

  const [dbActor] = await runner`
    SELECT user_id, user_type, full_name, email, mobile_no, member_id, 
           account_status, is_active, email_verified, is_otp_verified, 
           referred_by_user_id, sponsor_user_id
    FROM users 
    WHERE user_id = ${resolvedActorId}
  `;

  if (!dbActor || !['Active', 'Approved'].includes(String(dbActor.account_status))) {
    throw createBookingError('Actor account must be active and approved to perform bookings.', 403);
  }

  const normalizedActorType = String(dbActor.user_type || '').trim();
  let normalizedBuyerType = String(buyerType || 'SELF').toUpperCase();
  if (normalizedBuyerType === 'ON_BEHALF') {
    normalizedBuyerType = 'CUSTOMER';
  }

  // 2. Validate Plot Input Parameters
  const normalizedPlotId = Number(plotId);
  if (!normalizedPlotId || isNaN(normalizedPlotId)) {
    throw createBookingError('Valid plot_id is required.', 400);
  }

  const effectiveAdvance = advanceAmount !== undefined && advanceAmount !== null && advanceAmount !== ''
    ? advanceAmount
    : (bookingAmount || 0);
  const normalizedAdvance = Number(effectiveAdvance || 0);
  if (normalizedAdvance < 0 || isNaN(normalizedAdvance)) {
    throw createBookingError('Advance amount cannot be negative.', 400);
  }

  // Normalize payment type across all legacy options
  const rawPaymentType = paymentType || paymentOption || 'FullPayment';
  let normPaymentType = String(rawPaymentType).trim();
  if (['OneTime', 'Full', 'FullPayment'].includes(normPaymentType)) normPaymentType = 'FullPayment';
  else if (['PartWise', 'Partial', 'PartPayment'].includes(normPaymentType)) normPaymentType = 'Partial';
  else if (['DownPayment'].includes(normPaymentType)) normPaymentType = 'DownPayment';
  // Enforce EMI disabled for on-behalf bookings unless ALLOW_EMI_ON_BEHALF is explicitly enabled
  if (normPaymentType === 'EMI') {
    const isOnBehalf = ['Associate', 'Team Member'].includes(normalizedActorType) || normalizedBuyerType === 'CUSTOMER';
    if (isOnBehalf && !bookingApprovalConfig.ALLOW_EMI_ON_BEHALF) {
      throw createBookingError('Installment (EMI) option is currently unavailable for on-behalf bookings. Please choose One-Time or Part-Wise Payment.', 400);
    }
  }

  // 3. Server-side Attribution & Role-Based Derivation Matrix
  let derivedBookingType;
  let derivedBuyerUserId;
  let derivedBookedByUserId = dbActor.user_id;
  let derivedSoldByUserId;
  let derivedAssociateUserId;
  let derivedApprovalStatus;

  if (normalizedActorType === 'Customer') {
    if (normalizedBuyerType === 'CUSTOMER') {
      throw createBookingError('Customers cannot book plots on behalf of other customers.', 403);
    }
    // Customer SELF purchase
    derivedBookingType = 'CUSTOMER_SELF';
    derivedBuyerUserId = dbActor.user_id;
    derivedSoldByUserId = dbActor.referred_by_user_id || dbActor.sponsor_user_id || null;
    derivedAssociateUserId = derivedSoldByUserId ? await resolveAssociate(runner, derivedSoldByUserId) : null;
    derivedApprovalStatus = 'NotRequired';

  } else if (normalizedActorType === 'Team Member') {
    if (normalizedBuyerType === 'SELF') {
      derivedBookingType = 'SELF_PURCHASE';
      derivedBuyerUserId = dbActor.user_id;
      derivedSoldByUserId = dbActor.user_id;
      derivedAssociateUserId = await resolveAssociate(runner, dbActor.user_id);
      derivedApprovalStatus = bookingApprovalConfig.BOOKING_APPROVAL_ENABLED ? 'Pending' : 'NotRequired';

    } else if (normalizedBuyerType === 'CUSTOMER') {
      const targetCusId = Number(customerId);
      if (!targetCusId) {
        throw createBookingError('Customer selection is required for on-behalf bookings.', 400);
      }
      const [targetCustomer] = await runner`
        SELECT user_id, user_type, account_status, is_active, email_verified, is_otp_verified, referred_by_user_id, sponsor_user_id
        FROM users WHERE user_id = ${targetCusId}
      `;
      if (!targetCustomer) {
        throw createBookingError('Selected customer not found.', 404);
      }
      if (targetCustomer.user_type !== 'Customer') {
        throw createBookingError('Target user must be a Customer.', 400);
      }

      // Hard Rule: Team Member can ONLY book for customers directly referred by them
      if (Number(targetCustomer.referred_by_user_id) !== dbActor.user_id && Number(targetCustomer.sponsor_user_id) !== dbActor.user_id) {
        throw createBookingError('Unauthorized: Team Members can only book on behalf of customers directly referred by them.', 403);
      }

      derivedBookingType = 'ON_BEHALF_BY_TEAM_MEMBER';
      derivedBuyerUserId = targetCustomer.user_id;
      derivedSoldByUserId = dbActor.user_id;
      derivedAssociateUserId = await resolveAssociate(runner, dbActor.user_id);
      derivedApprovalStatus = bookingApprovalConfig.BOOKING_APPROVAL_ENABLED ? 'Pending' : 'NotRequired';
    } else {
      throw createBookingError(`Invalid buyerType '${buyerType}'. Expected 'SELF' or 'CUSTOMER'.`, 400);
    }

  } else if (normalizedActorType === 'Associate') {
    if (normalizedBuyerType === 'SELF') {
      derivedBookingType = 'SELF_PURCHASE';
      derivedBuyerUserId = dbActor.user_id;
      derivedSoldByUserId = dbActor.user_id;
      derivedAssociateUserId = dbActor.user_id;
      derivedApprovalStatus = 'AutoApproved_CreatedByAssociate';

    } else if (normalizedBuyerType === 'CUSTOMER') {
      const targetCusId = Number(customerId);
      if (!targetCusId) {
        throw createBookingError('Customer or Team Member selection is required for on-behalf bookings.', 400);
      }
      const [targetCustomer] = await runner`
        SELECT user_id, user_type, account_status, is_active, email_verified, is_otp_verified, referred_by_user_id, sponsor_user_id, member_id
        FROM users WHERE user_id = ${targetCusId}
      `;
      if (!targetCustomer) {
        throw createBookingError('Selected buyer (customer or team member) not found.', 404);
      }
      if (!['Customer', 'Team Member'].includes(targetCustomer.user_type)) {
        throw createBookingError('Target user must be a Customer or Team Member.', 400);
      }

      if (targetCustomer.user_type === 'Team Member') {
        // Hard Rule: Associate can book for a Team Member if:
        // (a) Team Member belongs to Associate in team_members table
        // (b) OR Team Member is directly referred or sponsored by Associate
        // (c) OR Team Member is in Associate's downline closure
        const isDirect = Number(targetCustomer.referred_by_user_id) === dbActor.user_id || 
                         Number(targetCustomer.sponsor_user_id) === dbActor.user_id;

        const [tmCheckDirect] = await runner`
          SELECT 1 FROM team_members
          WHERE (user_id = ${targetCustomer.user_id} OR team_member_uid = ${targetCustomer.member_id})
            AND associate_id = ${dbActor.user_id}
          LIMIT 1
        `;

        let isClosureDescendant = false;
        if (!isDirect && !tmCheckDirect) {
          try {
            const [closureCheck] = await runner`
              SELECT 1 FROM mlm_tree_closure
              WHERE ancestor_user_id = ${dbActor.user_id}
                AND descendant_user_id = ${targetCustomer.user_id}
              LIMIT 1
            `;
            isClosureDescendant = Boolean(closureCheck);
          } catch (_) {}
        }

        if (!isDirect && !tmCheckDirect && !isClosureDescendant) {
          throw createBookingError('Unauthorized: Team Member does not belong to your authorized team network.', 403);
        }

        derivedBookingType = 'ON_BEHALF_BY_ASSOCIATE';
        derivedBuyerUserId = targetCustomer.user_id;
        // Seller is attributed to the Team Member under this Associate
        derivedSoldByUserId = targetCustomer.user_id;
        derivedAssociateUserId = dbActor.user_id;
        derivedApprovalStatus = 'AutoApproved_CreatedByAssociate';

      } else {
        // Hard Rule: Associate can book if:
        // (a) Customer directly referred by Associate
        // (b) OR Customer referred by an active Team Member in Associate's downline
        const isDirectReferral = Number(targetCustomer.referred_by_user_id) === dbActor.user_id ||
                                 Number(targetCustomer.sponsor_user_id) === dbActor.user_id;
        let isTeamMemberReferral = false;
        const refId = targetCustomer.referred_by_user_id || targetCustomer.sponsor_user_id;
        if (!isDirectReferral && refId) {
          const [tmCheck] = await runner`
            SELECT 1 FROM team_members 
            WHERE (user_id = ${refId} OR team_member_uid = ${refId}) 
              AND associate_id = ${dbActor.user_id}
              AND (status IS NULL OR LOWER(status) IN ('approved', 'active', 'verified'))
            LIMIT 1
          `;
          isTeamMemberReferral = Boolean(tmCheck);
        }

        if (!isDirectReferral && !isTeamMemberReferral) {
          throw createBookingError('Unauthorized: Customer does not belong to your authorized team network.', 403);
        }

        derivedBookingType = 'ON_BEHALF_BY_ASSOCIATE';
        derivedBuyerUserId = targetCustomer.user_id;
        // Seller is the customer's actual referrer (actor if direct, TM if referred by TM)
        derivedSoldByUserId = refId || dbActor.user_id;
        derivedAssociateUserId = dbActor.user_id;
        derivedApprovalStatus = 'AutoApproved_CreatedByAssociate';
      }
    } else {
      throw createBookingError(`Invalid buyerType '${buyerType}'. Expected 'SELF' or 'CUSTOMER'.`, 400);
    }

  } else {
    // Investor, Admin, or any other user type attempting plot booking
    throw createBookingError('Unauthorized: Your user role is not permitted to initiate plot bookings.', 403);
  }

  // 4. Validate Buyer Compliance (Active, Email/Mobile verified, KYC approved)
  const [buyer] = await runner`
    SELECT u.user_id, u.full_name, u.email, u.mobile_no, u.member_id, u.account_status, u.user_type,
           (COALESCE(u.is_verified, FALSE) OR COALESCE(u.email_verified, FALSE) OR COALESCE(u.is_otp_verified, FALSE)) AS is_verified,
           COALESCE(k.status, 'Not Submitted') AS kyc_status
    FROM users u
    LEFT JOIN user_kyc_profiles k ON k.user_id = u.user_id
    WHERE u.user_id = ${derivedBuyerUserId}
  `;

  if (!buyer || !['active', 'approved'].includes(String(buyer.account_status || '').toLowerCase())) {
    throw createBookingError('Buyer account must be approved and active before booking.', 403);
  }
  if (!buyer.is_verified && buyer.user_type !== 'Team Member') {
    throw createBookingError('Buyer must verify their email or mobile before booking.', 403);
  }
  if (buyer.kyc_status !== 'Approved') {
    if (['Associate', 'Team Member'].includes(normalizedActorType)) {
      try {
        await runner`
          INSERT INTO user_kyc_profiles (user_id, status, submitted_at, approved_at, remarks)
          VALUES (${buyer.user_id}, 'Approved', NOW(), NOW(), 'Auto-approved on assisted booking')
          ON CONFLICT (user_id) DO UPDATE SET status = 'Approved', approved_at = NOW()
        `;
      } catch (_) {}
    } else if (['Submitted', 'Under Review'].includes(buyer.kyc_status)) {
      // Documents submitted by customer, allow booking submission to be placed into Processing/Verification queue
    } else {
      throw createBookingError('Buyer KYC documents must be submitted/approved before booking a plot.', 403);
    }
  }

  // 4b. Fetch Workflow Settings safely before transaction to avoid PG transaction aborts
  let workflowSettings = null;
  try {
    const [ws] = await runner`SELECT * FROM booking_workflow_settings WHERE id = 1`;
    workflowSettings = ws || null;
  } catch (wsErr) {
    console.warn('[BookingService] Notice fetching booking_workflow_settings:', wsErr.message);
  }

  // 5. ATOMIC DATABASE TRANSACTION (Concurrency & Race-Condition Safe)
  return await runner.begin(async (tx) => {
    // 5a. PostgreSQL Advisory Lock on the specific plot
    await tx`SELECT pg_advisory_xact_lock(${normalizedPlotId})`;

    // 5b. Fetch Plot with Row Lock (FOR UPDATE OF p)
    const [plot] = await tx`
      SELECT p.*, s.site_name
      FROM plots p
      LEFT JOIN sites s ON s.site_id = p.site_id
      WHERE p.plot_id = ${normalizedPlotId}
      FOR UPDATE OF p
    `;

    if (!plot || plot.is_active === false) {
      throw createBookingError('Plot not found or is currently inactive.', 404);
    }

    // Availability Check (Preserve existing business rule: Vacant or InProcess permitted)
    if (plot.plot_status === 'Booked' || plot.plot_status === 'Sold') {
      throw createBookingError('This plot is already booked or sold and no longer available.', 409);
    }

    // 5c. Duplicate Booking Guard for same buyer
    const [existingActiveBooking] = await tx`
      SELECT booking_id, booking_serial, booking_status 
      FROM bookings 
      WHERE plot_id = ${normalizedPlotId} 
        AND user_id = ${derivedBuyerUserId} 
        AND booking_status NOT IN ('Cancelled', 'Rejected')
      LIMIT 1
    `;
    if (existingActiveBooking) {
      throw createBookingError(`Buyer already has an active booking (${existingActiveBooking.booking_serial}) on this plot.`, 409);
    }

    // 5d. Queue Position Assignment (Race-free)
    const [queueRow] = await tx`
      SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_queue
      FROM bookings
      WHERE plot_id = ${normalizedPlotId}
        AND booking_status NOT IN ('Cancelled', 'Rejected')
    `;
    const queuePosition = Number(queueRow?.next_queue || 1);

    // 5e. Booking Serial Number Generation
    const [seqRow] = await tx`
      SELECT COALESCE(MAX(CAST(SUBSTRING(booking_serial FROM 10) AS INT)), 0) + 1 AS n
      FROM bookings 
      WHERE booking_serial LIKE 'MMR-' || to_char(NOW(), 'YYYY') || '-%'
    `;
    const serialNumber = `MMR-${new Date().getFullYear()}-${String(seqRow?.n || 1).padStart(5, '0')}`;

    // 5f. Compute Pricing, Installment Plans & Balances
    const minPlotPrice = Number(workflowSettings?.min_plot_price ?? 200000);
    const minEmiDownPayment = Number(workflowSettings?.min_emi_down_payment ?? 30000);
    const partWiseCount = Number(workflowSettings?.part_wise_installments ?? 4);
    const partWiseFirstPct = Number(workflowSettings?.part_wise_first_percent ?? 25);
    const partWiseGapDays = Number(workflowSettings?.part_wise_gap_days ?? 7);
    const deadlineMonths = Number(workflowSettings?.part_wise_deadline_months ?? 3);

    const staffRoles = ['Associate', 'Team Member', 'Admin', 'SuperAdmin', 'FinanceManager', 'SiteManager'];
    const isRoleAdmin = (r) => ['admin', 'superadmin', 'super_admin'].includes(String(r || '').toLowerCase());
    const isStaff = staffRoles.some(r => r.toLowerCase() === normalizedActorType.toLowerCase()) || 
                    isRoleAdmin(normalizedActorType) || 
                    Boolean(dbActor.is_admin || dbActor.admin_id);

    const listPrice = Number(plot.sold_price || plot.base_price || 0);
    const incomingPrice = Number(customPlotPrice || custom_plot_price || incomingPlotPrice || plot_price || base_price || 0);

    let agreedPrice = 0;
    let requestedPrice = null;
    let priceOverridden = false;
    let priceSetByUserId = null;
    let isPendingPriceApproval = false;
    let priceApprovalStatus = null;

    if (incomingPrice > 0) {
      agreedPrice = incomingPrice;
      priceOverridden = listPrice > 0 && Math.abs(incomingPrice - listPrice) > 0.01;
      priceSetByUserId = dbActor.user_id;
    } else if (listPrice > 0) {
      agreedPrice = listPrice;
      priceOverridden = false;
      priceSetByUserId = null;
    } else {
      throw createBookingError(`Plot price is unconfigured. Please enter the agreed plot price to proceed.`, 400);
    }

    if (agreedPrice < minPlotPrice && isStaff) {
      console.warn(`[BookingService] Staff ${dbActor.user_id} (${normalizedActorType}) overrode plot price to ₹${agreedPrice} (below ₹${minPlotPrice})`);
    }

    if (normalizedAdvance > agreedPrice && agreedPrice > 0) {
      throw createBookingError(`Advance amount (₹${normalizedAdvance}) cannot exceed the plot value (₹${agreedPrice}).`, 400);
    }

    if (normPaymentType === 'FullPayment' && !isPendingPriceApproval) {
      if (normalizedAdvance > 0 && normalizedAdvance < agreedPrice) {
        throw createBookingError(`FullPayment requires the full plot value (₹${agreedPrice.toLocaleString('en-IN')}). Received ₹${normalizedAdvance.toLocaleString('en-IN')}.`, 400);
      }
    }

    if ((normPaymentType === 'Partial' || normPaymentType === 'PartWise') && !isPendingPriceApproval) {
      const minFirstInstallment = Math.round((agreedPrice * partWiseFirstPct) / 100);
      if (normalizedAdvance < minFirstInstallment) {
        throw createBookingError(`Part-Wise payment requires the first installment to be at least ${partWiseFirstPct}% of total plot value (₹${minFirstInstallment.toLocaleString('en-IN')}). Received ₹${normalizedAdvance.toLocaleString('en-IN')}.`, 400);
      }
    }

    let selectedPlan = null;
    let planSnapshot = null;
    const resolvedPlanId = Number(installmentPlanId || installment_plan_id || 0);

    if (normPaymentType === 'EMI') {
      if (resolvedPlanId > 0) {
        selectedPlan = await installmentService.getInstallmentPlanById(tx, resolvedPlanId);
        if (!selectedPlan) {
          throw createBookingError(`Selected installment plan (ID ${resolvedPlanId}) not found.`, 404);
        }
        if (!selectedPlan.is_active) {
          throw createBookingError(`Selected installment plan (${selectedPlan.tenure_months} months) is currently inactive.`, 400);
        }
        planSnapshot = installmentService.calculateInstallmentPlan({
          price: agreedPrice,
          tenure: selectedPlan.tenure_months,
          interestPercent: selectedPlan.interest_percent,
          downPaymentPercent: selectedPlan.down_payment_percent,
          actualDownPayment: normalizedAdvance > 0 ? normalizedAdvance : undefined,
          minDownPaymentAmount: minEmiDownPayment,
        });

        if (!isStaff && normalizedAdvance > 0 && normalizedAdvance < planSnapshot.minimum_required_down_payment) {
          throw createBookingError(`Minimum down payment required for EMI is ₹${planSnapshot.minimum_required_down_payment.toLocaleString('en-IN')}. Received ₹${normalizedAdvance.toLocaleString('en-IN')}.`, 400);
        }
      }
    }

    // Part-wise deadline calculation
    let partWiseDeadlineAt = null;
    if (normPaymentType === 'Partial' || normPaymentType === 'PartWise') {
      const d = new Date();
      d.setMonth(d.getMonth() + deadlineMonths);
      partWiseDeadlineAt = d;
    }

    let initialAdvance = normalizedAdvance > 0 ? normalizedAdvance : (normPaymentType === 'FullPayment' ? agreedPrice : 0);
    if (planSnapshot && !isPendingPriceApproval) {
      initialAdvance = planSnapshot.down_payment_amount;
    }

    const finalStoredBasePrice = agreedPrice;
    const remainingBalance = planSnapshot && !isPendingPriceApproval
      ? planSnapshot.installment_base_amount
      : Math.max(0, agreedPrice - initialAdvance);

    let initialBookingStatus = bookingStatus;
    let initWorkflow = workflowStatus;

    if (isPendingPriceApproval) {
      initialBookingStatus = 'Pending Admin Price Approval';
      initWorkflow = 'Pending Admin Price Approval';
    } else {
      if (!initialBookingStatus) {
        initialBookingStatus = normPaymentType === 'FullPayment' ? 'Submitted' : 'PaymentPending';
      }
      if (!initWorkflow) {
        initWorkflow = normPaymentType === 'FullPayment' ? 'Booking Initiated' : 'Payment Pending';
      }
    }

    // 5g. Insert Booking Record (Never alters plots.base_price!)
    const autoApproved = derivedApprovalStatus === 'AutoApproved_CreatedByAssociate';
    const [booking] = await tx`
      INSERT INTO bookings (
        booking_serial, user_id, plot_id, site_id, payment_type, advance_amount,
        booking_status, workflow_status, payment_method, notes, queue_position,
        booked_by_user_id, sold_by_user_id, associate_user_id, booking_type,
        associate_approval_status, associate_approved_by, associate_approved_at,
        required_booking_amount, remaining_balance, base_price, booking_date, created_at, updated_at,
        installment_plan_id, plan_snapshot, part_wise_deadline_at,
        list_price, price_overridden, price_set_by_user_id, requested_price, price_approval_status,
        plot_area, area_unit
      ) VALUES (
        ${serialNumber}, ${derivedBuyerUserId}, ${normalizedPlotId}, ${siteId || plot.site_id},
        ${normPaymentType}, ${initialAdvance}, ${initialBookingStatus}, ${initWorkflow},
        ${paymentMethod || 'Online'}, ${notes || ''}, ${queuePosition},
        ${derivedBookedByUserId}, ${derivedSoldByUserId}, ${derivedAssociateUserId}, ${derivedBookingType},
        ${derivedApprovalStatus},
        ${autoApproved ? derivedBookedByUserId : null},
        ${autoApproved ? new Date() : null},
        ${requiredBookingAmount || initialAdvance}, ${remainingBalance}, ${finalStoredBasePrice}, CURRENT_DATE, NOW(), NOW(),
        ${selectedPlan ? selectedPlan.id : null}, ${planSnapshot ? tx.json(planSnapshot) : null}, ${partWiseDeadlineAt},
        ${listPrice > 0 ? listPrice : null}, ${priceOverridden}, ${priceSetByUserId}, ${requestedPrice}, ${priceApprovalStatus},
        ${plotArea || plot_area ? Number(plotArea || plot_area) : (plot?.plot_area ? Number(plot.plot_area) : null)},
        ${areaUnit || area_unit ? String(areaUnit || area_unit) : (plot?.area_unit ? String(plot.area_unit) : 'Gaj')}
      )
      RETURNING *
    `;

    // 5h. Update Plot Status based on payment type (Full settlement -> Booked, Partial/EMI/Approval -> InProcess)
    const isFullSettlement = !isPendingPriceApproval && (normPaymentType === 'FullPayment' || (initialAdvance >= agreedPrice && agreedPrice > 0));
    const nextPlotStatus = isFullSettlement ? 'Booked' : 'InProcess';
    await tx`UPDATE plots SET plot_status = ${nextPlotStatus}, updated_at = NOW() WHERE plot_id = ${normalizedPlotId}`;

    // 5i. Plot Booking Lock if requested (for customer checkout workflow)
    let lockToken = null;
    let lockExpiresAt = null;
    if (lockMinutes && lockMinutes > 0) {
      const [lock] = await tx`
        INSERT INTO plot_booking_locks (plot_id, user_id, booking_id, expires_at)
        VALUES (${normalizedPlotId}, ${derivedBuyerUserId}, ${booking.booking_id}, NOW() + make_interval(mins => ${Number(lockMinutes)}))
        RETURNING lock_token, expires_at
      `;
      lockToken = lock?.lock_token;
      lockExpiresAt = lock?.expires_at;
    }

    // 5j. Handle EMI or Part-Wise Schedules Generation (Only if price is confirmed / not pending approval)
    if (!isPendingPriceApproval) {
      if (normPaymentType === 'EMI') {
        const start = new Date();
        start.setMonth(start.getMonth() + 1);

        if (planSnapshot && Array.isArray(planSnapshot.schedule) && planSnapshot.schedule.length > 0) {
          for (const item of planSnapshot.schedule) {
            const due = new Date(start);
            due.setMonth(due.getMonth() + (item.installment_no - 1));
            await tx`
              INSERT INTO emi_schedules (
                booking_id, user_id, installment_no, due_date, emi_amount,
                late_fee_amount, total_due, paid_amount, emi_status,
                principal_component, interest_component, created_at, updated_at
              ) VALUES (
                ${booking.booking_id}, ${derivedBuyerUserId}, ${item.installment_no},
                ${due.toISOString().split('T')[0]}, ${item.emi_amount},
                0.00, ${item.emi_amount}, 0.00, 'Pending',
                ${item.principal_component}, ${item.interest_component}, NOW(), NOW()
              )
            `.catch(() => {});
          }
        }
      } else if (normPaymentType === 'Partial' || normPaymentType === 'PartWise') {
        // Generate Part-Wise 4-Installment Schedule (Installment 1 = Advance paid, Remaining 3 spaced 7 days apart)
        const totalPrincipalPaise = Math.round(agreedPrice * 100);
        const advancePaise = Math.round(initialAdvance * 100);
        const remainingPaise = Math.max(0, totalPrincipalPaise - advancePaise);
        const remInstallments = Math.max(1, partWiseCount - 1);
        const basePartPaise = Math.floor(remainingPaise / remInstallments);

        // Installment 1: Initial Advance (Due Today, Marked Paid if advance > 0)
        await tx`
          INSERT INTO emi_schedules (
            booking_id, user_id, installment_no, due_date, emi_amount,
            late_fee_amount, total_due, paid_amount, emi_status,
            principal_component, interest_component, created_at, updated_at
          ) VALUES (
            ${booking.booking_id}, ${derivedBuyerUserId}, 1,
            CURRENT_DATE, ${initialAdvance},
            0.00, ${initialAdvance}, ${initialAdvance}, ${initialAdvance > 0 ? 'Paid' : 'Pending'},
            ${initialAdvance}, 0.00, NOW(), NOW()
          )
        `.catch(() => {});

        // Installments 2 to 4: Spaced 7 days (partWiseGapDays) apart
        let cumRemPaise = 0;
        for (let p = 1; p <= remInstallments; p++) {
          const isLast = p === remInstallments;
          const partPaise = isLast ? (remainingPaise - cumRemPaise) : basePartPaise;
          cumRemPaise += partPaise;
          const partAmount = Math.round(partPaise) / 100;

          const dueDate = new Date();
          dueDate.setDate(dueDate.getDate() + (p * partWiseGapDays));

          await tx`
            INSERT INTO emi_schedules (
              booking_id, user_id, installment_no, due_date, emi_amount,
              late_fee_amount, total_due, paid_amount, emi_status,
              principal_component, interest_component, created_at, updated_at
            ) VALUES (
              ${booking.booking_id}, ${derivedBuyerUserId}, ${p + 1},
              ${dueDate.toISOString().split('T')[0]}, ${partAmount},
              0.00, ${partAmount}, 0.00, 'Pending',
              ${partAmount}, 0.00, NOW(), NOW()
            )
          `.catch(() => {});
        }
      }
    }

    // 5k. Insert Centralized Audit Log inside same transaction
    await recordBookingAudit(tx, {
      bookingId: booking.booking_id,
      action: 'BookingCreated',
      actorId: dbActor.user_id,
      actorType: normalizedActorType,
      actorName: dbActor.full_name,
      afterState: {
        booking_serial: serialNumber,
        booking_type: derivedBookingType,
        booked_by: derivedBookedByUserId,
        sold_by: derivedSoldByUserId,
        associate: derivedAssociateUserId,
        approval_status: derivedApprovalStatus,
        queue_position: queuePosition
      },
      reason: notes || 'Booking creation via shared service'
    });

    // Notification if approval is pending
    if (derivedApprovalStatus === 'Pending' && derivedAssociateUserId) {
      try {
        await tx`
          INSERT INTO notification_log (user_id, channel, title, message)
          VALUES (
            ${derivedAssociateUserId}, 'InApp', 'Booking Approval Required',
            ${'A new booking (' + serialNumber + ') for Plot ' + (plot.plot_number || '') + ' requires your review and approval.'}
          )
        `;
      } catch (_) {}
    }

    return {
      booking,
      plot,
      serial: serialNumber,
      queuePosition,
      lockToken,
      lockExpiresAt,
      actor: dbActor,
      buyer
    };
  });
}

/**
 * Shared helper to release plot status or promote the earliest waitlisted booking.
 * Used consistently across rejectBooking, admin cancellation, and workflow cancellation.
 */
export async function releasePlotOrPromoteWaitlist(db, { plotId, cancelledBookingId = null, adminId = null, reason = 'Booking cancelled' }) {
  if (!plotId) return { promotedBooking: null, plotStatus: null };
  await ensureBookingTableSchema(db);

  const [earliestWaitlisted] = await db`
    SELECT booking_id, user_id, queue_position 
    FROM bookings 
    WHERE plot_id = ${plotId} 
      AND booking_status = 'Waitlisted'
      ${cancelledBookingId ? db`AND booking_id <> ${cancelledBookingId}` : db``}
    ORDER BY queue_position ASC, created_at ASC
    LIMIT 1
  `;

  if (earliestWaitlisted) {
    // Promote waitlisted booking to Submitted / InProcess
    await db`
      UPDATE bookings 
      SET booking_status = 'Submitted', updated_at = NOW() 
      WHERE booking_id = ${earliestWaitlisted.booking_id}
    `;

    // Recalibrate remaining waitlist queue positions on the plot
    const remainingWaitlisted = await db`
      SELECT booking_id FROM bookings
      WHERE plot_id = ${plotId}
        AND booking_status = 'Waitlisted'
      ORDER BY queue_position ASC, created_at ASC
    `;
    let pos = 1;
    for (const w of remainingWaitlisted) {
      await db`UPDATE bookings SET queue_position = ${pos} WHERE booking_id = ${w.booking_id}`;
      pos++;
    }

    await db`UPDATE plots SET plot_status = 'InProcess', updated_at = NOW() WHERE plot_id = ${plotId}`;

    try {
      await db`
        INSERT INTO plot_booking_history (plot_id, booking_id, user_id, event_type, event_note, triggered_by_admin, plot_status_at_time, created_at)
        VALUES (${plotId}, ${earliestWaitlisted.booking_id}, ${earliestWaitlisted.user_id}, 'BookingPromotedFromWaitlist',
                'Booking promoted from waitlist to Submitted following cancellation', ${adminId}, 'InProcess', NOW())
      `;
    } catch (_) {}

    try {
      await db`
        INSERT INTO notification_log (user_id, sent_by_admin_id, channel, title, message)
        VALUES (
          ${earliestWaitlisted.user_id}, ${adminId}, 'InApp', 'Waitlist Booking Promoted',
          'Good news! A prior application was cancelled, and your waitlisted booking has been promoted to Submitted for processing.'
        )
      `;
    } catch (_) {}

    return { promotedBooking: earliestWaitlisted, plotStatus: 'InProcess' };
  } else {
    const [remaining] = await db`
      SELECT COUNT(*) AS count 
      FROM bookings 
      WHERE plot_id = ${plotId} 
        AND booking_status NOT IN ('Cancelled', 'Rejected')
        ${cancelledBookingId ? db`AND booking_id <> ${cancelledBookingId}` : db``}
    `;

    let plotStatus = 'InProcess';
    if (Number(remaining?.count || 0) === 0) {
      plotStatus = 'Vacant';
      await db`UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() WHERE plot_id = ${plotId}`;
    }

    return { promotedBooking: null, plotStatus };
  }
}

/**
 * Associate approves a pending booking
 */
export async function approveBooking({ bookingId, actorId, reason = '', customDb = null }) {
  const normBookingId = Number(bookingId);
  const normActorId = Number(actorId);
  const runner = customDb || sql;

  return await runner.begin(async (tx) => {
    const [booking] = await tx`
      SELECT * FROM bookings WHERE booking_id = ${normBookingId} FOR UPDATE
    `;
    if (!booking) {
      throw createBookingError('Booking not found.', 404);
    }
    if (Number(booking.associate_user_id) !== normActorId) {
      throw createBookingError('Unauthorized: You are not the assigned Associate leader for this booking.', 403);
    }
    if (booking.associate_approval_status !== 'Pending') {
      throw createBookingError(`Booking is not pending approval (Current status: ${booking.associate_approval_status}).`, 400);
    }

    const [updated] = await tx`
      UPDATE bookings SET
        associate_approval_status = 'Approved',
        associate_approved_by = ${normActorId},
        associate_approved_at = NOW(),
        updated_at = NOW()
      WHERE booking_id = ${normBookingId}
      RETURNING *
    `;

    await recordBookingAudit(tx, {
      bookingId: normBookingId,
      action: 'AssociateApproved',
      actorId: normActorId,
      actorType: 'Associate',
      beforeState: { associate_approval_status: 'Pending' },
      afterState: { associate_approval_status: 'Approved' },
      reason: reason || 'Approved by Associate'
    });

    try {
      await tx`
        INSERT INTO notification_log (user_id, channel, title, message)
        VALUES (${booking.user_id}, 'InApp', 'Booking Approved',
                ${'Your booking (' + booking.booking_serial + ') has been approved by your Associate leader.'})
      `;
      if (booking.booked_by_user_id && booking.booked_by_user_id !== booking.user_id) {
        await tx`
          INSERT INTO notification_log (user_id, channel, title, message)
          VALUES (${booking.booked_by_user_id}, 'InApp', 'Booking Approved',
                  ${'The booking (' + booking.booking_serial + ') you initiated has been approved by Associate.'})
        `;
      }
    } catch (_) {}

    return updated;
  });
}

/**
 * Associate rejects a pending booking (cancels booking and manages plot status)
 */
export async function rejectBooking({ bookingId, actorId, reason, customDb = null }) {
  const normBookingId = Number(bookingId);
  const normActorId = Number(actorId);
  if (!reason || !String(reason).trim()) {
    throw createBookingError('A rejection reason is mandatory.', 400);
  }
  const runner = customDb || sql;

  return await runner.begin(async (tx) => {
    const [booking] = await tx`
      SELECT * FROM bookings WHERE booking_id = ${normBookingId} FOR UPDATE
    `;
    if (!booking) {
      throw createBookingError('Booking not found.', 404);
    }
    if (Number(booking.associate_user_id) !== normActorId) {
      throw createBookingError('Unauthorized: You are not the assigned Associate leader for this booking.', 403);
    }

    const [updated] = await tx`
      UPDATE bookings SET
        associate_approval_status = 'Rejected',
        booking_status = 'Cancelled',
        associate_rejection_reason = ${reason},
        updated_at = NOW()
      WHERE booking_id = ${normBookingId}
      RETURNING *
    `;

    // Manage plot status transition upon rejection via unified helper
    await releasePlotOrPromoteWaitlist(tx, {
      plotId: booking.plot_id,
      cancelledBookingId: normBookingId,
      adminId: normActorId,
      reason: `Associate Rejected: ${reason}`
    });

    await recordBookingAudit(tx, {
      bookingId: normBookingId,
      action: 'AssociateRejected',
      actorId: normActorId,
      actorType: 'Associate',
      beforeState: { associate_approval_status: booking.associate_approval_status, booking_status: booking.booking_status },
      afterState: { associate_approval_status: 'Rejected', booking_status: 'Cancelled' },
      reason: reason
    });

    try {
      await tx`
        INSERT INTO notification_log (user_id, channel, title, message)
        VALUES (${booking.user_id}, 'InApp', 'Booking Rejected',
                ${'Your booking (' + booking.booking_serial + ') was rejected by Associate. Reason: ' + reason})
      `;
      if (booking.booked_by_user_id && booking.booked_by_user_id !== booking.user_id) {
        await tx`
          INSERT INTO notification_log (user_id, channel, title, message)
          VALUES (${booking.booked_by_user_id}, 'InApp', 'Booking Rejected',
                  ${'The booking (' + booking.booking_serial + ') you initiated was rejected by Associate. Reason: ' + reason})
        `;
      }
    } catch (_) {}

    return updated;
  });
}

/**
 * Admin overrides associate approval
 */
export async function overrideAssociateApproval({ bookingId, adminId, reason, customDb = null }) {
  const normBookingId = Number(bookingId);
  const normAdminId = Number(adminId);
  if (!reason || !String(reason).trim()) {
    throw createBookingError('An override reason is mandatory.', 400);
  }
  const runner = customDb || sql;

  return await runner.begin(async (tx) => {
    const [booking] = await tx`
      SELECT * FROM bookings WHERE booking_id = ${normBookingId} FOR UPDATE
    `;
    if (!booking) {
      throw createBookingError('Booking not found.', 404);
    }

    const [updated] = await tx`
      UPDATE bookings SET
        associate_approval_status = 'Approved',
        associate_approved_by = ${normAdminId},
        associate_approved_at = NOW(),
        associate_approval_overridden = TRUE,
        updated_at = NOW()
      WHERE booking_id = ${normBookingId}
      RETURNING *
    `;

    await recordBookingAudit(tx, {
      bookingId: normBookingId,
      action: 'AdminApprovalOverride',
      actorId: normAdminId,
      actorType: 'Admin',
      beforeState: { associate_approval_status: booking.associate_approval_status },
      afterState: { associate_approval_status: 'Approved', associate_approval_overridden: true },
      reason: reason,
      isOverride: true
    });

    try {
      if (booking.associate_user_id) {
        await tx`
          INSERT INTO notification_log (user_id, sent_by_admin_id, channel, title, message)
          VALUES (${booking.associate_user_id}, ${normAdminId}, 'InApp', 'Associate Approval Overridden',
                  ${'Admin has overridden associate approval on booking (' + booking.booking_serial + '). Reason: ' + reason})
        `;
      }
      await tx`
        INSERT INTO notification_log (user_id, sent_by_admin_id, channel, title, message)
        VALUES (${booking.user_id}, ${normAdminId}, 'InApp', 'Booking Approved (Admin Override)',
                ${'Your booking (' + booking.booking_serial + ') has been approved via Admin override.'})
      `;
    } catch (_) {}

    return updated;
  });
}

/**
 * Helper to mask phone number (Decision D5): 98******10
 */
export function maskPhoneNumber(phone) {
  if (!phone) return '';
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length < 6) return '******';
  const prefix = clean.slice(0, 2);
  const suffix = clean.slice(-2);
  return `${prefix}${'*'.repeat(Math.max(4, clean.length - 4))}${suffix}`;
}

/**
 * M3: Role-Wise Booking Detail Provider
 * Scopes data based on whether requesting user is Admin, Buyer, Seller, or Associate Downline.
 */
export async function getBookingDetailByRole(db = sql, bookingId, user = {}) {
  const normBookingId = Number(bookingId);
  if (!normBookingId || isNaN(normBookingId)) {
    throw createBookingError('Valid booking ID is required.', 400);
  }

  // 1. Fetch booking with joined buyer, seller, plot, and site details
  const [booking] = await db`
    SELECT b.*,
           -- Buyer user details
           bu.full_name AS buyer_name,
           bu.mobile_no AS buyer_mobile,
           bu.email AS buyer_email,
           bu.member_id AS buyer_member_id,
           bu.user_type AS buyer_user_type,
           ua.city AS buyer_city,
           ua.state AS buyer_state,
           -- Seller user details
           su.full_name AS seller_name,
           su.mobile_no AS seller_mobile,
           su.member_id AS seller_member_id,
           su.user_type AS seller_user_type,
           -- Associate supervisor details
           au.full_name AS associate_name,
           au.member_id AS associate_member_id,
           -- Plot details
           COALESCE(b.plot_number, p.plot_number, 'Plot') AS plot_number,
           COALESCE(b.plot_area, p.plot_area, 0) AS plot_area,
           COALESCE(p.plot_category::text, 'Residential') AS plot_category,
           COALESCE(b.base_price, p.base_price, 0) AS base_price,
           COALESCE(p.down_payment, 0) AS default_down_payment,
           COALESCE(p.monthly_emi, 0) AS default_monthly_emi,
           COALESCE(p.emi_tenure_months, 60) AS default_emi_tenure_months,
           COALESCE(p.plot_status, 'Booked') AS plot_status,
           -- Site details
           COALESCE(s.site_name, s2.site_name, 'Project Site') AS site_name,
           COALESCE(s.city, s2.city, 'Lucknow') AS site_city,
           COALESCE(s.full_address, s2.full_address, '') AS site_address
    FROM bookings b
    LEFT JOIN users bu ON bu.user_id = b.user_id
    LEFT JOIN user_addresses ua ON ua.user_id = b.user_id AND ua.address_type = 'Permanent'
    LEFT JOIN users su ON su.user_id = b.sold_by_user_id
    LEFT JOIN users au ON au.user_id = b.associate_user_id
    LEFT JOIN plots p  ON b.plot_id = p.plot_id
    LEFT JOIN sites s  ON p.site_id = s.site_id
    LEFT JOIN sites s2 ON b.site_id = s2.site_id
    WHERE b.booking_id = ${normBookingId}
  `;

  if (!booking) {
    throw createBookingError('Booking not found.', 404);
  }

  // 2. Determine requesting actor role & permissions
  const reqUserId = Number(user.user_id || user.id || 0);
  const userRole = String(user.role || user.user_type || '').trim().toLowerCase();
  const isAdmin = ['superadmin', 'admin', 'financemanager', 'sitemanager'].includes(userRole);
  const isBuyer = reqUserId > 0 && Number(booking.user_id) === reqUserId;
  const isSeller = reqUserId > 0 && Number(booking.sold_by_user_id) === reqUserId;
  const isAssociateSupervisor = reqUserId > 0 && Number(booking.associate_user_id) === reqUserId;

  // Check if user has commission entries for this booking (team pool or associate payout)
  let hasCommissionEntry = false;
  if (!isAdmin && !isBuyer && !isSeller && !isAssociateSupervisor && reqUserId > 0) {
    const [commRow] = await db`
      SELECT 1 FROM commission_transactions
      WHERE booking_id = ${normBookingId} AND recipient_user_id = ${reqUserId}
      LIMIT 1
    `;
    hasCommissionEntry = !!commRow;
  }

  if (!isAdmin && !isBuyer && !isSeller && !isAssociateSupervisor && !hasCommissionEntry) {
    throw createBookingError('You do not have permission to view this booking.', 403);
  }

  // 3. Fetch EMI Schedules
  let emiSchedule = [];
  try {
    emiSchedule = await db`
      SELECT emi_id, installment_no, due_date, emi_amount, principal_component, interest_component,
             late_fee_amount, total_due, paid_amount, paid_date, emi_status, payment_mode, utr_number
      FROM emi_schedules
      WHERE booking_id = ${normBookingId}
      ORDER BY installment_no
    `;
  } catch (_) {}

  // 4. Fetch Payment Proofs (Admin and Buyer only; excluded for Seller/Associate to prevent privacy leaks)
  let paymentProofs = [];
  if (isAdmin || isBuyer) {
    try {
      paymentProofs = await db`
        SELECT proof_id, file_url, payment_mode, amount, transaction_reference, status, created_at
        FROM booking_payment_proofs
        WHERE booking_id = ${normBookingId}
        ORDER BY created_at DESC
      `;
    } catch (_) {}
  }

  // 5. Fetch Commission Data (Scoped strictly by role)
  let commissions = [];
  if (isAdmin) {
    try {
      commissions = await db`
        SELECT ct.commission_id, ct.recipient_user_id, u.full_name AS recipient_name,
               u.member_id AS recipient_member_id, ct.distribution_role, ct.commission_percentage,
               ct.commission_amount, ct.net_amount, ct.commission_status, ct.payment_reference,
               ct.paid_at, ct.needs_review, ct.review_reason
        FROM commission_transactions ct
        LEFT JOIN users u ON u.user_id = ct.recipient_user_id
        WHERE ct.booking_id = ${normBookingId}
        ORDER BY ct.commission_id ASC
      `;
    } catch (_) {}
  } else if (isSeller || isAssociateSupervisor || hasCommissionEntry) {
    try {
      commissions = await db`
        SELECT ct.commission_id, ct.recipient_user_id, ct.distribution_role,
               ct.commission_percentage, ct.commission_amount, ct.net_amount,
               ct.commission_status, ct.payment_reference, ct.paid_at
        FROM commission_transactions ct
        WHERE ct.booking_id = ${normBookingId} AND ct.recipient_user_id = ${reqUserId}
      `;
    } catch (_) {}
  }

  // 6. Financial Calculations & Part-Wise Deadline Math
  const totalPrice = Number(booking.total_amount || booking.base_price || 0);
  const advanceAmount = Number(booking.advance_amount || 0);
  const paidEmisTotal = emiSchedule
    .filter(e => e.emi_status === 'Paid')
    .reduce((sum, e) => sum + Number(e.paid_amount || e.emi_amount || 0), 0);
  const confirmedPaid = Math.max(advanceAmount + paidEmisTotal, Number(booking.total_paid || 0), advanceAmount);
  const unpaidBalance = Math.max(0, totalPrice - confirmedPaid);

  const isPartWise = (booking.payment_type === 'PartWise' || booking.payment_type === 'Partial');
  let partWiseOverdue = false;
  let partWiseDaysRemaining = 0;
  let partWiseDeadlineAt = booking.part_wise_deadline_at || null;

  if (isPartWise) {
    if (!partWiseDeadlineAt && (booking.booking_date || booking.created_at)) {
      const d = new Date(booking.booking_date || booking.created_at);
      d.setMonth(d.getMonth() + 3);
      partWiseDeadlineAt = d.toISOString();
    }
    if (partWiseDeadlineAt) {
      const diffMs = new Date(partWiseDeadlineAt).getTime() - Date.now();
      partWiseDaysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      partWiseOverdue = (diffMs < 0 && unpaidBalance > 0);
    }
  }

  // 7. Role-Specific Data Projection
  // Privacy rule (Decision D5): Mask customer phone for Seller / Associate / Team Member
  const shouldMaskCustomerPhone = !isAdmin && !isBuyer;
  const roleView = isAdmin ? 'Admin' : isBuyer ? 'Customer' : isSeller ? 'Seller' : 'Associate';

  return {
    booking_id: booking.booking_id,
    booking_serial: booking.booking_serial,
    booking_status: booking.booking_status,
    booking_date: booking.booking_date || booking.created_at,
    role_view: roleView,
    plot: {
      plot_id: booking.plot_id,
      plot_number: booking.plot_number,
      plot_area: booking.plot_area,
      plot_category: booking.plot_category,
      plot_status: booking.plot_status,
      base_price: booking.base_price,
      registry_status: booking.registry_status,
      registry_date: booking.registry_date
    },
    site: {
      site_id: booking.site_id,
      site_name: booking.site_name,
      city: booking.site_city,
      address: booking.site_address
    },
    customer: {
      user_id: booking.user_id,
      name: booking.buyer_name || 'Customer',
      member_id: booking.buyer_member_id || '',
      city: booking.buyer_city || '',
      state: booking.buyer_state || '',
      mobile_no: shouldMaskCustomerPhone ? maskPhoneNumber(booking.buyer_mobile) : (booking.buyer_mobile || ''),
      email: shouldMaskCustomerPhone ? '—' : (booking.buyer_email || ''),
      is_masked: shouldMaskCustomerPhone
    },
    seller: {
      user_id: booking.sold_by_user_id,
      name: booking.seller_name || 'MMR Associate',
      member_id: booking.seller_member_id || '',
      user_type: booking.seller_user_type || 'Associate'
    },
    financials: {
      total_price: totalPrice,
      advance_amount: advanceAmount,
      confirmed_paid: confirmedPaid,
      unpaid_balance: unpaidBalance,
      payment_type: booking.payment_type || 'Full',
      part_wise: {
        is_part_wise: isPartWise,
        deadline_at: partWiseDeadlineAt,
        days_remaining: partWiseDaysRemaining,
        is_overdue: partWiseOverdue
      },
      installment_plan_id: booking.installment_plan_id,
      plan_snapshot: booking.plan_snapshot || null
    },
    emi_schedule: emiSchedule,
    payment_proofs: paymentProofs,
    commissions: commissions,
    notes: booking.notes || null,
    created_at: booking.created_at,
    updated_at: booking.updated_at
  };
}

export default {
  createBooking,
  approveBooking,
  rejectBooking,
  overrideAssociateApproval,
  resolveAssociate,
  releasePlotOrPromoteWaitlist,
  recordBookingAudit,
  getBookingDetailByRole,
  maskPhoneNumber
};

