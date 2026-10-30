/**
 * MMR Construction & Developers Pvt. Ltd.
 * Booking Approvals & Bookable Customers Routes (Phase 2)
 *
 * Endpoints:
 * - GET /api/associate/booking-approvals
 * - POST /api/associate/booking-approvals/:bookingId/approve
 * - POST /api/associate/booking-approvals/:bookingId/reject
 * - POST /api/admin/bookings/:id/override-associate-approval
 * - GET /api/my-bookable-customers
 */

import express from 'express';
import sql from '../db.js';
import { verifyUserToken, verifyAdminToken, role, resolveEffectivePanel } from '../middleware/auth.middleware.js';
import bookingService from '../services/bookingService.js';
import bookingApprovalConfig from '../config/bookingApproval.js';

const router = express.Router();

function ok(res, data = null, message = 'Success', extra = {}) {
  return res.json({ success: true, message, data, ...extra });
}

function err(res, message = 'Error', code = 400) {
  return res.status(code).json({ success: false, message });
}

function maskMobile(mobile) {
  if (!mobile) return null;
  const str = String(mobile).replace(/\D/g, '');
  if (str.length < 4) return '******';
  return '******' + str.slice(-4);
}

/**
 * 1. GET /api/associate/booking-approvals
 * List bookings assigned to the logged-in Associate for approval
 */
router.get('/associate/booking-approvals', verifyUserToken, async (req, res) => {
  try {
    if (resolveEffectivePanel(req.user) === 'team-member') {
      return err(res, 'Access denied: Associate access required (current session is acting as Team Member).', 403);
    }
    const [actor] = await sql`SELECT user_id, user_type, account_status FROM users WHERE user_id = ${req.user.user_id}`;
    if (!actor || actor.user_type !== 'Associate' || !['Active', 'Approved'].includes(actor.account_status)) {
      return err(res, 'Access denied. Only active Associates can manage booking approvals.', 403);
    }
    const associateId = actor.user_id;

    const { status, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [sql`b.associate_user_id = ${associateId}`];
    if (status) {
      conditions.push(sql`b.associate_approval_status = ${status}`);
    }

    const rows = await sql`
      SELECT 
        b.booking_id,
        b.booking_serial,
        b.booking_date,
        b.booking_status,
        b.advance_amount,
        b.payment_type,
        b.payment_method,
        b.booking_type,
        b.associate_approval_status,
        b.associate_approved_at,
        b.associate_rejection_reason,
        b.associate_approval_overridden,
        b.created_at,
        p.plot_number,
        p.plot_area,
        COALESCE(p.sold_price, p.base_price, 0) AS sale_value,
        s.site_name,
        buyer.user_id AS buyer_id,
        buyer.full_name AS buyer_name,
        buyer.member_id AS buyer_member_id,
        booker.user_id AS booked_by_id,
        booker.full_name AS booked_by_name,
        booker.member_id AS booked_by_member_id,
        booker.user_type AS booked_by_role
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = COALESCE(p.site_id, b.site_id)
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      LEFT JOIN users booker ON booker.user_id = b.booked_by_user_id
      WHERE ${conditions.reduce((acc, curr) => sql`${acc} AND ${curr}`)}
      ORDER BY b.created_at DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const [totalRow] = await sql`
      SELECT COUNT(*)::INT AS total
      FROM bookings b
      WHERE ${conditions.reduce((acc, curr) => sql`${acc} AND ${curr}`)}
    `;

    return ok(res, rows, 'Booking approvals retrieved successfully.', {
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: Number(totalRow?.total || 0),
        pages: Math.ceil(Number(totalRow?.total || 0) / limitNum)
      }
    });
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * 2. POST /api/associate/booking-approvals/:bookingId/approve
 * Associate approves a pending booking
 */
/**
 * 2a. POST /api/associate/booking-approvals/:bookingId/decide
 * Unified decide endpoint used by Associate portal frontend (supports both 'approve' and 'reject')
 */
router.post('/associate/booking-approvals/:bookingId/decide', verifyUserToken, async (req, res) => {
  try {
    if (resolveEffectivePanel(req.user) === 'team-member') {
      return err(res, 'Access denied: Associate access required (current session is acting as Team Member).', 403);
    }
    const bookingId = Number(req.params.bookingId);
    const { decision, reason, decision_notes, rejection_reason } = req.body || {};
    const [actor] = await sql`SELECT user_id, user_type, account_status FROM users WHERE user_id = ${req.user.user_id}`;
    if (!actor || actor.user_type !== 'Associate' || !['Active', 'Approved'].includes(actor.account_status)) {
      return err(res, 'Access denied: Only active Associates can review bookings.', 403);
    }
    const associateId = actor.user_id;

    const normDecision = String(decision || '').toLowerCase();
    if (normDecision === 'approve') {
      const updated = await bookingService.approveBooking({
        bookingId,
        actorId: associateId,
        reason: reason || decision_notes || ''
      });
      return ok(res, updated, 'Booking approval granted successfully.');
    } else if (normDecision === 'reject') {
      const note = reason || rejection_reason || decision_notes;
      if (!note || !String(note).trim()) {
        return err(res, 'A rejection reason is mandatory.', 400);
      }
      const updated = await bookingService.rejectBooking({
        bookingId,
        actorId: associateId,
        reason: String(note).trim()
      });
      return ok(res, updated, 'Booking has been rejected and cancelled.');
    } else {
      return err(res, 'Invalid decision. Must be "approve" or "reject".', 400);
    }
  } catch (e) {
    return err(res, e.message, e.status || 400);
  }
});

router.post('/associate/booking-approvals/:bookingId/approve', verifyUserToken, async (req, res) => {
  try {
    if (resolveEffectivePanel(req.user) === 'team-member') {
      return err(res, 'Access denied: Associate access required (current session is acting as Team Member).', 403);
    }
    const bookingId = Number(req.params.bookingId);
    const { reason, decision_notes } = req.body || {};
    const [actor] = await sql`SELECT user_id, user_type, account_status FROM users WHERE user_id = ${req.user.user_id}`;
    if (!actor || actor.user_type !== 'Associate' || !['Active', 'Approved'].includes(actor.account_status)) {
      return err(res, 'Access denied: Only active Associates can approve bookings.', 403);
    }
    const associateId = actor.user_id;

    const updated = await bookingService.approveBooking({
      bookingId,
      actorId: associateId,
      reason: reason || decision_notes || ''
    });

    return ok(res, updated, 'Booking approval granted successfully.');
  } catch (e) {
    return err(res, e.message, e.status || 400);
  }
});

/**
 * 3. POST /api/associate/booking-approvals/:bookingId/reject
 * Associate rejects a pending booking (reason mandatory; cancels booking & manages plot release)
 */
router.post('/associate/booking-approvals/:bookingId/reject', verifyUserToken, async (req, res) => {
  try {
    if (resolveEffectivePanel(req.user) === 'team-member') {
      return err(res, 'Access denied: Associate access required (current session is acting as Team Member).', 403);
    }
    const bookingId = Number(req.params.bookingId);
    const { reason, rejection_reason, decision_notes } = req.body || {};
    const [actor] = await sql`SELECT user_id, user_type, account_status FROM users WHERE user_id = ${req.user.user_id}`;
    if (!actor || actor.user_type !== 'Associate' || !['Active', 'Approved'].includes(actor.account_status)) {
      return err(res, 'Access denied: Only active Associates can reject bookings.', 403);
    }
    const associateId = actor.user_id;
    const note = reason || rejection_reason || decision_notes;
    if (!note || !String(note).trim()) {
      return err(res, 'A rejection reason is mandatory.', 400);
    }

    const updated = await bookingService.rejectBooking({
      bookingId,
      actorId: associateId,
      reason: String(note).trim()
    });

    return ok(res, updated, 'Booking has been rejected and cancelled.');
  } catch (e) {
    return err(res, e.message, e.status || 400);
  }
});

/**
 * 4. POST /api/admin/bookings/:id/override-associate-approval
 * Admin overrides Associate approval requirement
 */
router.post(['/admin/bookings/:id/override-associate-approval', '/admin/bookings/:id/override-approval'], verifyAdminToken, role('SuperAdmin', 'FinanceManager'), async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const adminId = req.admin.admin_id;
    const { reason } = req.body || {};

    if (!reason || !String(reason).trim()) {
      return err(res, 'An override reason is mandatory.', 400);
    }

    const updated = await bookingService.overrideAssociateApproval({
      bookingId,
      adminId,
      reason: String(reason).trim()
    });

    return ok(res, updated, 'Admin approval override granted successfully.');
  } catch (e) {
    return err(res, e.message, e.status || 400);
  }
});

/**
 * 5. GET /api/my-bookable-customers
 * Retrieve customers that the authenticated sales entity is authorized to book for
 */
router.get('/my-bookable-customers', verifyUserToken, async (req, res) => {
  try {
    const [freshActor] = await sql`SELECT user_id, user_type, account_status FROM users WHERE user_id = ${req.user.user_id}`;
    if (!freshActor || !['Active', 'Approved'].includes(freshActor.account_status)) {
      return err(res, 'Access denied: Active account required.', 403);
    }
    const callerId = freshActor.user_id;
    const effectivePanel = resolveEffectivePanel(req.user);
    const callerType = effectivePanel === 'team-member' ? 'Team Member' : freshActor.user_type;

    if (!['Associate', 'Team Member'].includes(callerType)) {
      return err(res, 'Access denied: Active sales entities only.', 403);
    }
    const { page = 1, limit = 20, search } = req.query;

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));
    const offset = (pageNum - 1) * limitNum;

    let rows;
    let countResult;

    if (callerType === 'Team Member') {
      // Team Member can only book for customers directly referred by them
      const searchPattern = search ? `%${String(search).trim()}%` : null;

      rows = await sql`
        SELECT 
          c.user_id,
          c.member_id,
          c.full_name,
          c.account_status,
          (COALESCE(c.email_verified, FALSE) OR COALESCE(c.is_otp_verified, FALSE)) AS is_verified,
          COALESCE(k.status, 'Not Submitted') AS kyc_status,
          'DIRECT' AS relationship,
          u.user_id AS referrer_user_id,
          u.full_name AS referrer_name,
          u.member_id AS referrer_member_id,
          c.mobile_no
        FROM users c
        LEFT JOIN users u ON u.user_id = COALESCE(c.referred_by_user_id, c.sponsor_user_id)
        LEFT JOIN user_kyc_profiles k ON k.user_id = c.user_id
        WHERE c.user_type = 'Customer'
          AND c.account_status = 'Active'
          AND (c.referred_by_user_id = ${callerId} OR c.sponsor_user_id = ${callerId})
          ${searchPattern ? sql`AND (c.full_name ILIKE ${searchPattern} OR c.member_id ILIKE ${searchPattern} OR c.mobile_no ILIKE ${searchPattern})` : sql``}
        ORDER BY c.full_name ASC
        LIMIT ${limitNum} OFFSET ${offset}
      `;

      countResult = await sql`
        SELECT COUNT(*)::INT AS total
        FROM users c
        WHERE c.user_type = 'Customer'
          AND c.account_status = 'Active'
          AND (c.referred_by_user_id = ${callerId} OR c.sponsor_user_id = ${callerId})
          ${searchPattern ? sql`AND (c.full_name ILIKE ${searchPattern} OR c.member_id ILIKE ${searchPattern} OR c.mobile_no ILIKE ${searchPattern})` : sql``}
      `;

    } else {
      // Associate: directly referred customers OR customers referred by active Team Members in downline
      const searchPattern = search ? `%${String(search).trim()}%` : null;
      const teamMemberId = req.query.team_member_id ? Number(req.query.team_member_id) : null;
      const filterType = String(req.query.type || '').trim().toUpperCase(); // 'DIRECT' or 'TEAM_MEMBER'

      rows = await sql`
        SELECT 
          c.user_id,
          c.member_id,
          c.full_name,
          c.account_status,
          (COALESCE(c.email_verified, FALSE) OR COALESCE(c.is_otp_verified, FALSE)) AS is_verified,
          COALESCE(k.status, 'Not Submitted') AS kyc_status,
          CASE 
            WHEN c.referred_by_user_id = ${callerId} OR c.sponsor_user_id = ${callerId} THEN 'DIRECT'
            ELSE 'TEAM_MEMBER'
          END AS relationship,
          ref.user_id AS referrer_user_id,
          ref.full_name AS referrer_name,
          ref.member_id AS referrer_member_id,
          c.mobile_no
        FROM users c
        JOIN users ref ON ref.user_id = COALESCE(c.referred_by_user_id, c.sponsor_user_id)
        LEFT JOIN user_kyc_profiles k ON k.user_id = c.user_id
        WHERE c.user_type = 'Customer'
          AND c.account_status = 'Active'
          ${teamMemberId ? sql`AND (c.referred_by_user_id = ${teamMemberId} OR c.sponsor_user_id = ${teamMemberId})` : 
            (filterType === 'DIRECT' ? sql`AND (c.referred_by_user_id = ${callerId} OR c.sponsor_user_id = ${callerId})` :
            sql`AND (
              c.referred_by_user_id = ${callerId}
              OR c.sponsor_user_id = ${callerId}
              OR c.referred_by_user_id IN (
                SELECT tm.user_id FROM team_members tm 
                WHERE tm.associate_id = ${callerId} AND tm.status IN ('approved', 'active')
              )
              OR c.sponsor_user_id IN (
                SELECT tm.user_id FROM team_members tm 
                WHERE tm.associate_id = ${callerId} AND tm.status IN ('approved', 'active')
              )
            )`)}
          ${searchPattern ? sql`AND (c.full_name ILIKE ${searchPattern} OR c.member_id ILIKE ${searchPattern} OR c.mobile_no ILIKE ${searchPattern})` : sql``}
        ORDER BY relationship ASC, c.full_name ASC
        LIMIT ${limitNum} OFFSET ${offset}
      `;

      countResult = await sql`
        SELECT COUNT(*)::INT AS total
        FROM users c
        WHERE c.user_type = 'Customer'
          AND c.account_status = 'Active'
          ${teamMemberId ? sql`AND (c.referred_by_user_id = ${teamMemberId} OR c.sponsor_user_id = ${teamMemberId})` : 
            (filterType === 'DIRECT' ? sql`AND (c.referred_by_user_id = ${callerId} OR c.sponsor_user_id = ${callerId})` :
            sql`AND (
              c.referred_by_user_id = ${callerId}
              OR c.sponsor_user_id = ${callerId}
              OR c.referred_by_user_id IN (
                SELECT tm.user_id FROM team_members tm 
                WHERE tm.associate_id = ${callerId} AND tm.status IN ('approved', 'active')
              )
              OR c.sponsor_user_id IN (
                SELECT tm.user_id FROM team_members tm 
                WHERE tm.associate_id = ${callerId} AND tm.status IN ('approved', 'active')
              )
            )`)}
          ${searchPattern ? sql`AND (c.full_name ILIKE ${searchPattern} OR c.member_id ILIKE ${searchPattern} OR c.mobile_no ILIKE ${searchPattern})` : sql``}
      `;
    }

    // Protect customer privacy: Mask mobile number, do not expose full mobile or email
    const sanitizedRows = rows.map(r => ({
      user_id: r.user_id,
      member_id: r.member_id,
      full_name: r.full_name,
      mobile_no: r.mobile_no,
      masked_mobile: maskMobile(r.mobile_no),
      account_status: r.account_status,
      is_verified: Boolean(r.is_verified),
      kyc_status: r.kyc_status,
      is_eligible_to_book: (r.account_status === 'Active' && r.is_verified && r.kyc_status === 'Approved'),
      relationship: r.relationship,
      referrer_user_id: r.referrer_user_id,
      referrer_name: r.referrer_name,
      referrer_member_id: r.referrer_member_id
    }));

    return ok(res, sanitizedRows, 'Bookable customers retrieved successfully.', {
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: Number(countResult[0]?.total || 0),
        pages: Math.ceil(Number(countResult[0]?.total || 0) / limitNum)
      }
    });
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * 6. GET /api/booking-capabilities
 * Returns booking capability flags & allowed payment methods
 */
router.get(['/booking-capabilities', '/bookings/capabilities'], (req, res) => {
  return ok(res, {
    allow_emi_on_behalf: Boolean(bookingApprovalConfig.ALLOW_EMI_ON_BEHALF),
    booking_approval_enabled: Boolean(bookingApprovalConfig.BOOKING_APPROVAL_ENABLED),
    referral_invalid_code_mode: bookingApprovalConfig.REFERRAL_INVALID_CODE_MODE,
    allowed_payment_methods: [
      'Bank Transfer / NEFT / RTGS',
      'UPI / QR Code',
      'Online Payment Gateway'
    ]
  }, 'Booking capabilities retrieved successfully.');
});

/* =========================================================================
   7. ADMIN PRICE APPROVAL WORKFLOW FOR CUSTOMER BOOKINGS (Part 2B)
   ========================================================================= */

/**
 * GET /api/admin/bookings/price-approval-requests
 * List customer bookings requiring admin rate confirmation
 */
router.get('/admin/bookings/price-approval-requests', verifyAdminToken, role('SuperAdmin', 'Admin', 'FinanceManager', 'SiteManager'), async (req, res) => {
  try {
    const rows = await sql`
      SELECT 
        b.booking_id, b.booking_serial, b.booking_status, b.workflow_status,
        b.payment_type, b.advance_amount, b.notes, b.created_at,
        b.list_price, b.requested_price, b.base_price, b.price_approval_status,
        b.price_admin_counter, b.price_rejection_reason,
        p.plot_id, p.plot_number, p.plot_area, p.unit_type,
        s.site_id, s.site_name,
        u.user_id AS customer_user_id, u.full_name AS customer_name,
        u.mobile_no AS customer_mobile, u.email AS customer_email
      FROM bookings b
      JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      JOIN users u ON u.user_id = b.user_id
      WHERE b.booking_status = 'Pending Admin Price Approval'
         OR b.price_approval_status = 'Pending'
         OR b.price_approval_status = 'CounterProposed'
      ORDER BY b.created_at DESC
    `;
    return ok(res, rows, 'Price approval requests fetched successfully.');
  } catch (e) {
    console.error('[PriceApprovalRequests Error]:', e);
    return err(res, e.message);
  }
});

/**
 * POST /api/admin/bookings/:id/price-approval/approve
 * Admin approves proposed rate or sets finalized rate
 */
router.post('/admin/bookings/:id/price-approval/approve', verifyAdminToken, role('SuperAdmin', 'Admin', 'FinanceManager'), async (req, res) => {
  const bookingId = Number(req.params.id);
  const { approved_price, notes } = req.body || {};

  try {
    const result = await sql.begin(async (tx) => {
      const [booking] = await tx`
        SELECT b.*, p.plot_area, p.plot_number, p.unit_type
        FROM bookings b
        JOIN plots p ON p.plot_id = b.plot_id
        WHERE b.booking_id = ${bookingId}
        FOR UPDATE
      `;
      if (!booking) throw new Error('Booking not found');

      const finalPrice = Number(approved_price || booking.requested_price || booking.list_price || 0);
      if (finalPrice <= 0) {
        throw new Error('Approved plot price must be greater than zero.');
      }

      const initialAdvance = Number(booking.advance_amount || 0);
      const remainingBalance = Math.max(0, finalPrice - initialAdvance);
      const nextBookingStatus = booking.payment_type === 'FullPayment' ? 'Submitted' : 'PaymentPending';
      const nextWorkflowStatus = 'Price Approved by Admin';

      // Update booking with approved price
      const [updated] = await tx`
        UPDATE bookings SET
          base_price = ${finalPrice},
          remaining_balance = ${remainingBalance},
          booking_status = ${nextBookingStatus},
          workflow_status = ${nextWorkflowStatus},
          price_approval_status = 'Approved',
          price_approved_by = ${req.admin.admin_id},
          price_approved_at = NOW(),
          notes = CASE WHEN ${notes || ''} != '' THEN COALESCE(notes, '') || E'\\n[Admin Price Approval]: ' || ${notes || ''} ELSE notes END,
          updated_at = NOW()
        WHERE booking_id = ${bookingId}
        RETURNING *
      `;

      // Update plot status to InProcess
      await tx`
        UPDATE plots 
        SET plot_status = 'InProcess', updated_at = NOW() 
        WHERE plot_id = ${booking.plot_id}
      `;

      // If EMI: generate EMI schedules
      if (booking.payment_type === 'EMI' && booking.installment_plan_id) {
        const [plan] = await tx`SELECT * FROM installment_plans WHERE id = ${booking.installment_plan_id}`;
        if (plan) {
          const [settings] = await sql`SELECT * FROM booking_workflow_settings WHERE id = 1`.catch(() => [{ min_emi_down_payment: 30000 }]);
          const planSnapshot = installmentService.calculateInstallmentPlan({
            price: finalPrice,
            tenure: plan.tenure_months,
            interestPercent: plan.interest_percent,
            downPaymentPercent: plan.down_payment_percent,
            actualDownPayment: initialAdvance,
            minDownPaymentAmount: Number(settings?.min_emi_down_payment || 30000)
          });

          await tx`
            UPDATE bookings SET 
              plan_snapshot = ${tx.json(planSnapshot)},
              remaining_balance = ${planSnapshot.installment_base_amount}
            WHERE booking_id = ${bookingId}
          `;

          const start = new Date();
          start.setMonth(start.getMonth() + 1);
          for (const item of planSnapshot.schedule) {
            const due = new Date(start);
            due.setMonth(due.getMonth() + (item.installment_no - 1));
            await tx`
              INSERT INTO emi_schedules (
                booking_id, user_id, installment_no, due_date, emi_amount,
                late_fee_amount, total_due, paid_amount, emi_status,
                principal_component, interest_component, created_at, updated_at
              ) VALUES (
                ${bookingId}, ${booking.user_id}, ${item.installment_no},
                ${due.toISOString().split('T')[0]}, ${item.emi_amount},
                0.00, ${item.emi_amount}, 0.00, 'Pending',
                ${item.principal_component}, ${item.interest_component}, NOW(), NOW()
              )
              ON CONFLICT (booking_id, installment_no) DO UPDATE SET
                emi_amount = EXCLUDED.emi_amount,
                total_due = EXCLUDED.total_due,
                principal_component = EXCLUDED.principal_component,
                interest_component = EXCLUDED.interest_component,
                updated_at = NOW()
            `;
          }
        }
      } else if (booking.payment_type === 'Partial' || booking.payment_type === 'PartWise') {
        // Generate Part-Wise 4 installments
        const [settings] = await sql`SELECT * FROM booking_workflow_settings WHERE id = 1`.catch(() => [{ part_wise_gap_days: 7, part_wise_installments: 4 }]);
        const partWiseCount = Number(settings?.part_wise_installments || 4);
        const gapDays = Number(settings?.part_wise_gap_days || 7);

        const totalPrincipalPaise = Math.round(finalPrice * 100);
        const advancePaise = Math.round(initialAdvance * 100);
        const remainingPaise = Math.max(0, totalPrincipalPaise - advancePaise);
        const remInstallments = Math.max(1, partWiseCount - 1);
        const basePartPaise = Math.floor(remainingPaise / remInstallments);

        // Installment 1: Initial Advance
        await tx`
          INSERT INTO emi_schedules (
            booking_id, user_id, installment_no, due_date, emi_amount,
            late_fee_amount, total_due, paid_amount, emi_status,
            principal_component, interest_component, created_at, updated_at
          ) VALUES (
            ${bookingId}, ${booking.user_id}, 1,
            CURRENT_DATE, ${initialAdvance},
            0.00, ${initialAdvance}, ${initialAdvance}, ${initialAdvance > 0 ? 'Paid' : 'Pending'},
            ${initialAdvance}, 0.00, NOW(), NOW()
          )
          ON CONFLICT (booking_id, installment_no) DO UPDATE SET
            emi_amount = EXCLUDED.emi_amount,
            paid_amount = EXCLUDED.paid_amount,
            updated_at = NOW()
        `.catch(() => {});

        let cumRemPaise = 0;
        for (let p = 1; p <= remInstallments; p++) {
          const isLast = p === remInstallments;
          const partPaise = isLast ? (remainingPaise - cumRemPaise) : basePartPaise;
          cumRemPaise += partPaise;
          const partAmount = Math.round(partPaise) / 100;

          const dueDate = new Date();
          dueDate.setDate(dueDate.getDate() + (p * gapDays));

          await tx`
            INSERT INTO emi_schedules (
              booking_id, user_id, installment_no, due_date, emi_amount,
              late_fee_amount, total_due, paid_amount, emi_status,
              principal_component, interest_component, created_at, updated_at
            ) VALUES (
              ${bookingId}, ${booking.user_id}, ${p + 1},
              ${dueDate.toISOString().split('T')[0]}, ${partAmount},
              0.00, ${partAmount}, 0.00, 'Pending',
              ${partAmount}, 0.00, NOW(), NOW()
            )
            ON CONFLICT (booking_id, installment_no) DO UPDATE SET
              emi_amount = EXCLUDED.emi_amount,
              total_due = EXCLUDED.total_due,
              updated_at = NOW()
          `.catch(() => {});
        }
      }

      // Log into audit_log
      await tx`
        INSERT INTO audit_log (
          event_type, action, table_name, record_id, user_id, actor_type,
          before_state, after_state, created_at
        ) VALUES (
          'PriceApproval', 'AdminApprovedCustomerRate', 'bookings', ${bookingId},
          ${req.admin.admin_id}, 'Admin',
          ${tx.json({ requested_price: booking.requested_price, status: booking.booking_status })},
          ${tx.json({ approved_price: finalPrice, status: nextBookingStatus })},
          NOW()
        )
      `.catch(() => {});

      return updated;
    });

    return ok(res, result, 'Plot rate approved and booking payment schedule activated.');
  } catch (e) {
    console.error('[Admin Price Approve Error]:', e);
    return err(res, e.message);
  }
});

/**
 * POST /api/admin/bookings/:id/price-approval/counter
 * Admin offers a counter price
 */
router.post('/admin/bookings/:id/price-approval/counter', verifyAdminToken, role('SuperAdmin', 'Admin', 'FinanceManager'), async (req, res) => {
  const bookingId = Number(req.params.id);
  const { counter_price, notes } = req.body || {};

  if (!counter_price || Number(counter_price) <= 0) {
    return err(res, 'Counter price must be greater than zero.', 400);
  }

  try {
    const [updated] = await sql`
      UPDATE bookings SET
        price_admin_counter = ${Number(counter_price)},
        price_approval_status = 'CounterProposed',
        notes = CASE WHEN ${notes || ''} != '' THEN COALESCE(notes, '') || E'\\n[Admin Counter Offer]: ₹' || ${Number(counter_price)} || ' - ' || ${notes || ''} ELSE notes END,
        updated_at = NOW()
      WHERE booking_id = ${bookingId}
      RETURNING *
    `;
    if (!updated) return err(res, 'Booking not found', 404);

    return ok(res, updated, `Counter price ₹${Number(counter_price).toLocaleString('en-IN')} proposed to customer.`);
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * POST /api/admin/bookings/:id/price-approval/reject
 * Admin rejects the customer proposed price
 */
router.post('/admin/bookings/:id/price-approval/reject', verifyAdminToken, role('SuperAdmin', 'Admin', 'FinanceManager'), async (req, res) => {
  const bookingId = Number(req.params.id);
  const { reason = 'Price proposal rejected by administration' } = req.body || {};

  try {
    const [updated] = await sql`
      UPDATE bookings SET
        booking_status = 'Rejected',
        workflow_status = 'Price Rejected',
        price_approval_status = 'Rejected',
        price_rejection_reason = ${reason},
        updated_at = NOW()
      WHERE booking_id = ${bookingId}
      RETURNING *
    `;
    if (!updated) return err(res, 'Booking not found', 404);

    // Release plot back to Vacant
    await sql`
      UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() 
      WHERE plot_id = ${updated.plot_id}
    `;

    return ok(res, updated, 'Customer rate proposal rejected and plot released.');
  } catch (e) {
    return err(res, e.message);
  }
});

export default router;
