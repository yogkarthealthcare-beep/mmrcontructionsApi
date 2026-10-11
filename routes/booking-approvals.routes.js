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
router.post('/associate/booking-approvals/:bookingId/approve', verifyUserToken, async (req, res) => {
  try {
    if (resolveEffectivePanel(req.user) === 'team-member') {
      return err(res, 'Access denied: Associate access required (current session is acting as Team Member).', 403);
    }
    const bookingId = Number(req.params.bookingId);
    const { reason } = req.body || {};
    const [actor] = await sql`SELECT user_id, user_type, account_status FROM users WHERE user_id = ${req.user.user_id}`;
    if (!actor || actor.user_type !== 'Associate' || !['Active', 'Approved'].includes(actor.account_status)) {
      return err(res, 'Access denied: Only active Associates can approve bookings.', 403);
    }
    const associateId = actor.user_id;

    const updated = await bookingService.approveBooking({
      bookingId,
      actorId: associateId,
      reason
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
    const { reason } = req.body || {};
    const [actor] = await sql`SELECT user_id, user_type, account_status FROM users WHERE user_id = ${req.user.user_id}`;
    if (!actor || actor.user_type !== 'Associate' || !['Active', 'Approved'].includes(actor.account_status)) {
      return err(res, 'Access denied: Only active Associates can reject bookings.', 403);
    }
    const associateId = actor.user_id;
    if (!reason || !String(reason).trim()) {
      return err(res, 'A rejection reason is mandatory.', 400);
    }

    const updated = await bookingService.rejectBooking({
      bookingId,
      actorId: associateId,
      reason: String(reason).trim()
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
router.post('/admin/bookings/:id/override-associate-approval', verifyAdminToken, role('SuperAdmin', 'FinanceManager'), async (req, res) => {
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
          u.full_name AS referrer_name,
          u.member_id AS referrer_member_id,
          c.mobile_no
        FROM users c
        JOIN users u ON u.user_id = c.referred_by_user_id
        LEFT JOIN user_kyc_profiles k ON k.user_id = c.user_id
        WHERE c.user_type = 'Customer'
          AND c.account_status = 'Active'
          AND c.referred_by_user_id = ${callerId}
          ${searchPattern ? sql`AND (c.full_name ILIKE ${searchPattern} OR c.member_id ILIKE ${searchPattern})` : sql``}
        ORDER BY c.full_name ASC
        LIMIT ${limitNum} OFFSET ${offset}
      `;

      countResult = await sql`
        SELECT COUNT(*)::INT AS total
        FROM users c
        WHERE c.user_type = 'Customer'
          AND c.account_status = 'Active'
          AND c.referred_by_user_id = ${callerId}
          ${searchPattern ? sql`AND (c.full_name ILIKE ${searchPattern} OR c.member_id ILIKE ${searchPattern})` : sql``}
      `;

    } else {
      // Associate: directly referred customers OR customers referred by active Team Members in downline
      const searchPattern = search ? `%${String(search).trim()}%` : null;

      rows = await sql`
        SELECT 
          c.user_id,
          c.member_id,
          c.full_name,
          c.account_status,
          (COALESCE(c.email_verified, FALSE) OR COALESCE(c.is_otp_verified, FALSE)) AS is_verified,
          COALESCE(k.status, 'Not Submitted') AS kyc_status,
          CASE 
            WHEN c.referred_by_user_id = ${callerId} THEN 'DIRECT'
            ELSE 'TEAM_MEMBER'
          END AS relationship,
          ref.full_name AS referrer_name,
          ref.member_id AS referrer_member_id,
          c.mobile_no
        FROM users c
        JOIN users ref ON ref.user_id = c.referred_by_user_id
        LEFT JOIN user_kyc_profiles k ON k.user_id = c.user_id
        WHERE c.user_type = 'Customer'
          AND c.account_status = 'Active'
          AND (
            c.referred_by_user_id = ${callerId}
            OR c.referred_by_user_id IN (
              SELECT tm.user_id FROM team_members tm 
              WHERE tm.associate_id = ${callerId} AND tm.status IN ('approved', 'active')
            )
          )
          ${searchPattern ? sql`AND (c.full_name ILIKE ${searchPattern} OR c.member_id ILIKE ${searchPattern})` : sql``}
        ORDER BY relationship ASC, c.full_name ASC
        LIMIT ${limitNum} OFFSET ${offset}
      `;

      countResult = await sql`
        SELECT COUNT(*)::INT AS total
        FROM users c
        WHERE c.user_type = 'Customer'
          AND c.account_status = 'Active'
          AND (
            c.referred_by_user_id = ${callerId}
            OR c.referred_by_user_id IN (
              SELECT tm.user_id FROM team_members tm 
              WHERE tm.associate_id = ${callerId} AND tm.status IN ('approved', 'active')
            )
          )
          ${searchPattern ? sql`AND (c.full_name ILIKE ${searchPattern} OR c.member_id ILIKE ${searchPattern})` : sql``}
      `;
    }

    // Protect customer privacy: Mask mobile number, do not expose full mobile or email
    const sanitizedRows = rows.map(r => ({
      user_id: r.user_id,
      member_id: r.member_id,
      full_name: r.full_name,
      masked_mobile: maskMobile(r.mobile_no),
      account_status: r.account_status,
      is_verified: Boolean(r.is_verified),
      kyc_status: r.kyc_status,
      is_eligible_to_book: (r.account_status === 'Active' && r.is_verified && r.kyc_status === 'Approved'),
      relationship: r.relationship,
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

export default router;
