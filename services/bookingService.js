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
      timestamp: new Date().toISOString()
    };
    await db`
      INSERT INTO audit_log (
        actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value
      ) VALUES (
        ${actorType}, ${actorId}, ${actorName}, 'Bookings', ${action}, 'bookings', ${bookingId}, ${JSON.stringify(details)}
      )
    `;
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
  customDb = null
}) {
  const runner = customDb || sql;

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
  const normalizedBuyerType = String(buyerType || 'SELF').toUpperCase();

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
    derivedSoldByUserId = dbActor.referred_by_user_id || null;
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
        SELECT user_id, user_type, account_status, is_active, email_verified, is_otp_verified, referred_by_user_id
        FROM users WHERE user_id = ${targetCusId}
      `;
      if (!targetCustomer) {
        throw createBookingError('Selected customer not found.', 404);
      }
      if (targetCustomer.user_type !== 'Customer') {
        throw createBookingError('Target user must be a Customer.', 400);
      }

      // Hard Rule: Team Member can ONLY book for customers directly referred by them
      if (Number(targetCustomer.referred_by_user_id) !== dbActor.user_id) {
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
        throw createBookingError('Customer selection is required for on-behalf bookings.', 400);
      }
      const [targetCustomer] = await runner`
        SELECT user_id, user_type, account_status, is_active, email_verified, is_otp_verified, referred_by_user_id
        FROM users WHERE user_id = ${targetCusId}
      `;
      if (!targetCustomer) {
        throw createBookingError('Selected customer not found.', 404);
      }
      if (targetCustomer.user_type !== 'Customer') {
        throw createBookingError('Target user must be a Customer.', 400);
      }

      // Hard Rule: Associate can book if:
      // (a) Customer directly referred by Associate
      // (b) OR Customer referred by an active Team Member in Associate's downline
      const isDirectReferral = Number(targetCustomer.referred_by_user_id) === dbActor.user_id;
      let isTeamMemberReferral = false;
      if (!isDirectReferral && targetCustomer.referred_by_user_id) {
        const [tmCheck] = await runner`
          SELECT 1 FROM team_members 
          WHERE user_id = ${targetCustomer.referred_by_user_id} 
            AND associate_id = ${dbActor.user_id}
            AND status IN ('approved', 'active')
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
      derivedSoldByUserId = targetCustomer.referred_by_user_id || dbActor.user_id;
      derivedAssociateUserId = dbActor.user_id;
      derivedApprovalStatus = 'AutoApproved_CreatedByAssociate';
    } else {
      throw createBookingError(`Invalid buyerType '${buyerType}'. Expected 'SELF' or 'CUSTOMER'.`, 400);
    }

  } else {
    // Investor, Admin, or any other user type attempting plot booking
    throw createBookingError('Unauthorized: Your user role is not permitted to initiate plot bookings.', 403);
  }

  // 4. Validate Buyer Compliance (Active, Email/Mobile verified, KYC approved)
  const [buyer] = await runner`
    SELECT u.user_id, u.full_name, u.email, u.mobile_no, u.member_id, u.account_status,
           (COALESCE(u.email_verified, FALSE) OR COALESCE(u.is_otp_verified, FALSE)) AS is_verified,
           COALESCE(k.status, 'Not Submitted') AS kyc_status
    FROM users u
    LEFT JOIN user_kyc_profiles k ON k.user_id = u.user_id
    WHERE u.user_id = ${derivedBuyerUserId}
  `;

  if (!buyer || !['Active', 'Approved'].includes(String(buyer.account_status))) {
    throw createBookingError('Buyer account must be approved and active before booking.', 403);
  }
  if (!buyer.is_verified) {
    throw createBookingError('Buyer must verify their email or mobile before booking.', 403);
  }
  if (buyer.kyc_status !== 'Approved') {
    throw createBookingError('Buyer KYC documents must be approved before booking a plot.', 403);
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

    // 5f. Compute Pricing & Balances
    const plotPrice = Number(plot.sold_price || plot.base_price || 0);
    const initialAdvance = normalizedAdvance > 0 ? normalizedAdvance : (normPaymentType === 'FullPayment' ? plotPrice : 0);
    const remainingBalance = Math.max(0, plotPrice - initialAdvance);

    const initialBookingStatus = bookingStatus || (normPaymentType === 'FullPayment' ? 'Submitted' : 'PaymentPending');
    const initWorkflow = workflowStatus || (normPaymentType === 'FullPayment' ? 'Booking Initiated' : 'Payment Pending');

    // 5g. Insert Booking Record
    const autoApproved = derivedApprovalStatus === 'AutoApproved_CreatedByAssociate';
    const [booking] = await tx`
      INSERT INTO bookings (
        booking_serial, user_id, plot_id, site_id, payment_type, advance_amount,
        booking_status, workflow_status, payment_method, notes, queue_position,
        booked_by_user_id, sold_by_user_id, associate_user_id, booking_type,
        associate_approval_status, associate_approved_by, associate_approved_at,
        required_booking_amount, remaining_balance, booking_date, created_at, updated_at
      ) VALUES (
        ${serialNumber}, ${derivedBuyerUserId}, ${normalizedPlotId}, ${siteId || plot.site_id},
        ${normPaymentType}, ${initialAdvance}, ${initialBookingStatus}, ${initWorkflow},
        ${paymentMethod || 'Online'}, ${notes || ''}, ${queuePosition},
        ${derivedBookedByUserId}, ${derivedSoldByUserId}, ${derivedAssociateUserId}, ${derivedBookingType},
        ${derivedApprovalStatus},
        ${autoApproved ? derivedBookedByUserId : null},
        ${autoApproved ? new Date() : null},
        ${requiredBookingAmount || initialAdvance}, ${remainingBalance}, CURRENT_DATE, NOW(), NOW()
      )
      RETURNING *
    `;

    // 5h. Mark Plot InProcess if Vacant
    if (plot.plot_status === 'Vacant') {
      await tx`UPDATE plots SET plot_status = 'InProcess', updated_at = NOW() WHERE plot_id = ${normalizedPlotId}`;
    }

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

    // 5j. Handle EMI Schedules Generation if EMI
    if (normPaymentType === 'EMI') {
      const start = new Date();
      start.setMonth(start.getMonth() + 1);
      const tenure = Number(plot.emi_tenure_months || 60);
      for (let i = 1; i <= tenure; i++) {
        const due = new Date(start);
        due.setMonth(due.getMonth() + (i - 1));
        await tx`
          INSERT INTO emi_schedules (booking_id, user_id, installment_no, due_date, emi_amount)
          VALUES (${booking.booking_id}, ${derivedBuyerUserId}, ${i}, ${due.toISOString().split('T')[0]}, ${plot.monthly_emi || 0})
        `.catch(() => {});
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

export default {
  createBooking,
  approveBooking,
  rejectBooking,
  overrideAssociateApproval,
  resolveAssociate,
  releasePlotOrPromoteWaitlist,
  recordBookingAudit
};
