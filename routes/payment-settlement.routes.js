/**
 * MMR Construction & Developers Pvt. Ltd.
 * Dedicated Plot Orders Payment Settlement API
 *
 * Endpoints:
 * 1. GET  /api/admin/payment-settlements           - List eligible plot orders with settlement details & KPIs
 * 2. GET  /api/admin/payment-settlements/:id/preview - Preview verified recipient-wise commission distribution
 * 3. POST /api/admin/payment-settlements/:id/release - Execute release with transaction, idempotency & audit trail
 * 4. POST /api/admin/payment-settlements/:id/cancel  - Cancel settlement request with reason & audit logging
 */

import express from 'express';
import sql from '../db.js';
import { verifyAdminToken, role } from '../middleware/auth.middleware.js';
import commissionService from '../services/commissionService.js';
import { triggerCommissionSettlementEmailsAsync } from '../services/businessNotificationEmail.service.js';

const router = express.Router();

function ok(res, data = null, message = 'Success', extra = {}) {
  return res.json({ success: true, message, data, ...extra });
}

function err(res, message = 'Error', code = 400) {
  return res.status(code).json({ success: false, message });
}

/**
 * Idempotent schema extension for payment settlement
 */
let settlementSchemaPromise = null;
async function ensureSettlementSchema() {
  if (!settlementSchemaPromise) {
    settlementSchemaPromise = (async () => {
      try {
        await sql.unsafe(`
          ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_status VARCHAR(30) DEFAULT 'Pending';
          ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_released_at TIMESTAMPTZ;
          ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_released_by INT;
          ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_reference VARCHAR(100);
          ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_cancelled_at TIMESTAMPTZ;
          ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_cancelled_by INT;
          ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_cancel_reason TEXT;
          ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_audit_log JSONB DEFAULT '[]'::jsonb;

          -- Clean up any duplicate records in admin_users from legacy database imports
          DELETE FROM admin_users a
          USING admin_users b
          WHERE a.ctid < b.ctid AND a.admin_id = b.admin_id;

          ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
          ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS approved_by_admin_id INT;
          ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
          ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
          ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS payment_reference TEXT;
          ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS notes TEXT;

          CREATE TABLE IF NOT EXISTS plot_order_settlements (
            settlement_id SERIAL PRIMARY KEY,
            booking_id INT NOT NULL,
            settlement_reference VARCHAR(100) UNIQUE NOT NULL,
            admin_id INT,
            admin_name VARCHAR(150),
            total_plot_price NUMERIC(14,2) DEFAULT 0,
            amount_received NUMERIC(14,2) DEFAULT 0,
            pool_amount NUMERIC(14,2) DEFAULT 0,
            total_distributed NUMERIC(14,2) DEFAULT 0,
            company_share NUMERIC(14,2) DEFAULT 0,
            recipient_breakdown JSONB,
            previous_status VARCHAR(30) DEFAULT 'Pending',
            new_status VARCHAR(30) DEFAULT 'Released',
            notes TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_plot_order_settlements_booking ON plot_order_settlements(booking_id);
          CREATE INDEX IF NOT EXISTS idx_bookings_settlement_status ON bookings(settlement_status);
          CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_source_events_bk_src ON commission_source_events (booking_id, source_type, source_id);

          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'commission_source_events_source_type_check'
                AND conrelid = 'commission_source_events'::regclass
            ) THEN
              ALTER TABLE commission_source_events DROP CONSTRAINT commission_source_events_source_type_check;
            END IF;
            ALTER TABLE commission_source_events
              ADD CONSTRAINT commission_source_events_source_type_check
              CHECK (source_type IN ('FullPayment','InitialPayment','EmiPayment','PartialPayment','Manual','BookingAdvance','MilestonePayment','OnlinePayment','OfflinePayment','PaymentSettlement'));
          END $$;
        `);
      } catch (e) {
        console.warn('[PaymentSettlement] Schema setup notice:', e.message);
      }
    })();
  }
  return settlementSchemaPromise;
}

// Auto-run schema check
ensureSettlementSchema();

/**
 * 1. GET /api/admin/payment-settlements
 * List eligible plot orders with rich referral/seller attribution and settlement tracking.
 */
router.get(['/admin/payment-settlements', '/api/admin/payment-settlements'], verifyAdminToken, async (req, res) => {
  try {
    await ensureSettlementSchema();

    const {
      search = '',
      status = 'ALL',
      page = 1,
      limit = 15,
      from_date = '',
      to_date = ''
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 15));
    const offset = (pageNum - 1) * limitNum;

    const q = String(search || '').trim();
    const searchFilter = q ? sql`
      (
        b.booking_serial ILIKE ${'%' + q + '%'}
        OR CAST(b.booking_id AS TEXT) ILIKE ${'%' + q + '%'}
        OR buyer.full_name ILIKE ${'%' + q + '%'}
        OR buyer.member_id ILIKE ${'%' + q + '%'}
        OR buyer.mobile_no ILIKE ${'%' + q + '%'}
        OR seller.full_name ILIKE ${'%' + q + '%'}
        OR seller.member_id ILIKE ${'%' + q + '%'}
        OR assoc.full_name ILIKE ${'%' + q + '%'}
        OR assoc.member_id ILIKE ${'%' + q + '%'}
        OR sponsor.member_id ILIKE ${'%' + q + '%'}
        OR p.plot_number ILIKE ${'%' + q + '%'}
        OR s.site_name ILIKE ${'%' + q + '%'}
      )
    ` : sql`TRUE`;

    const statusFilter = status && status !== 'ALL'
      ? (status === 'Pending'
          ? sql`COALESCE(b.settlement_status, 'Pending') = 'Pending'`
          : sql`b.settlement_status = ${status}`)
      : sql`TRUE`;

    const fromDateFilter = from_date ? sql`b.created_at >= ${from_date}::timestamptz` : sql`TRUE`;
    const toDateFilter = to_date ? sql`b.created_at <= (${to_date}::date + INTERVAL '1 day')::timestamptz` : sql`TRUE`;

    // Strict eligibility condition:
    // Only show plot orders booked by an external customer through an active Team Member under an Associate Leader.
    // Excludes direct self-purchases by Associates or Team Members, Company Direct sales, and Associate Direct sales.
    const eligibilityFilter = sql`
      b.plot_id IS NOT NULL
      AND (
        b.booking_status IN ('Confirmed', 'Approved', 'Pending', 'PaymentPending', 'Under Process', 'Submitted')
        OR COALESCE(b.advance_amount, 0) > 0
        OR COALESCE(b.settlement_status, 'Pending') != 'Pending'
      )
      AND b.booking_status NOT IN ('Cancelled', 'Rejected')

      -- 1. Buyer MUST be an external Customer (Associate & Team Member self-purchases are strictly excluded)
      AND COALESCE(b.booking_type, '') != 'SELF_PURCHASE'
      AND COALESCE(CAST(buyer.user_type AS TEXT), 'Customer') = 'Customer'
      AND NOT EXISTS (
        SELECT 1 FROM team_members tm_buyer
        WHERE tm_buyer.user_id = b.user_id
          AND LOWER(tm_buyer.status) IN ('approved', 'active')
      )
      AND b.user_id != COALESCE(b.sold_by_user_id, b.booked_by_user_id, buyer.referred_by_user_id, buyer.sponsor_user_id, 0)

      -- 2. Sale MUST be through an active Team Member under an Associate
      AND COALESCE(b.sold_by_user_id, b.booked_by_user_id, buyer.referred_by_user_id, buyer.sponsor_user_id) IS NOT NULL
      AND (CAST(seller.user_type AS TEXT) = 'Team Member' OR tm_record.id IS NOT NULL)
      AND COALESCE(tm_record.associate_id, b.associate_user_id, seller.sponsor_user_id) IS NOT NULL
    `;

    // Summary KPIs (Strictly deduplicated by booking_id)
    const [metrics] = await sql`
      WITH filtered_bookings AS (
        SELECT DISTINCT ON (b.booking_id)
          b.booking_id,
          COALESCE(b.settlement_status, 'Pending') AS settlement_status,
          COALESCE(b.advance_amount, 0)::numeric AS advance_amount
        FROM bookings b
        LEFT JOIN plots p ON p.plot_id = b.plot_id
        LEFT JOIN sites s ON s.site_id = p.site_id
        LEFT JOIN users buyer ON buyer.user_id = b.user_id
        LEFT JOIN users seller ON seller.user_id = COALESCE(b.sold_by_user_id, b.booked_by_user_id, buyer.referred_by_user_id, buyer.sponsor_user_id)
        LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id
        LEFT JOIN users sponsor ON sponsor.user_id = buyer.sponsor_user_id
        LEFT JOIN LATERAL (
          SELECT id, team_member_uid, associate_id, status
          FROM team_members
          WHERE user_id = COALESCE(b.sold_by_user_id, b.booked_by_user_id, buyer.referred_by_user_id, buyer.sponsor_user_id)
            AND LOWER(status) IN ('approved', 'active')
          ORDER BY created_at DESC
          LIMIT 1
        ) tm_record ON TRUE
        WHERE ${eligibilityFilter}
          AND ${searchFilter}
          AND ${statusFilter}
          AND ${fromDateFilter}
          AND ${toDateFilter}
        ORDER BY b.booking_id DESC
      )
      SELECT
        COUNT(*)::int AS total_orders,
        COUNT(CASE WHEN settlement_status = 'Pending' THEN 1 END)::int AS pending_count,
        COUNT(CASE WHEN settlement_status = 'Released' THEN 1 END)::int AS released_count,
        COUNT(CASE WHEN settlement_status = 'Cancelled' THEN 1 END)::int AS cancelled_count,
        COALESCE(SUM(advance_amount), 0)::numeric AS total_received_amount,
        COALESCE(SUM(CASE WHEN settlement_status = 'Released' THEN advance_amount ELSE 0 END), 0)::numeric AS total_settled_amount
      FROM filtered_bookings
    `;

    // Paginated settlement orders (Strictly deduplicated by booking_id with single-record joins)
    const orders = await sql`
      SELECT DISTINCT ON (b.booking_id)
        b.booking_id,
        b.booking_serial,
        COALESCE(b.booking_date, b.created_at) AS booking_date,
        b.booking_status,
        b.booking_type,
        (COALESCE(CAST(buyer.user_type AS TEXT), 'Customer') != 'Customer' AND (b.booking_type = 'SELF_PURCHASE' OR b.user_id = b.sold_by_user_id)) AS is_self_purchase,
        (b.sold_by_user_id IS NULL) AS is_company_direct,
        COALESCE(b.advance_amount, 0)::numeric AS amount_received,
        COALESCE(b.remaining_balance, 0)::numeric AS remaining_balance,
        COALESCE(b.base_price, p.sold_price, p.base_price, (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0)::numeric AS total_plot_price,
        b.payment_type,
        b.payment_method,

        -- Settlement specific fields
        COALESCE(b.settlement_status, 'Pending') AS settlement_status,
        b.settlement_released_at,
        b.settlement_reference,
        b.settlement_cancelled_at,
        b.settlement_cancel_reason,
        rel_admin.full_name AS released_by_admin_name,

        -- Buyer / Customer Details
        b.user_id AS buyer_user_id,
        buyer.full_name AS buyer_name,
        buyer.member_id AS buyer_member_id,
        buyer.mobile_no AS buyer_mobile,
        buyer.email AS buyer_email,
        buyer.user_type AS buyer_user_type,

        -- Seller Details (can be Team Member or Associate)
        b.sold_by_user_id,
        seller.full_name AS seller_name,
        seller.member_id AS seller_member_id,
        seller.user_type AS seller_user_type,
        seller.mobile_no AS seller_mobile,
        seller.email AS seller_email,

        -- Team Member Details (if seller is Team Member or enrolled)
        CASE 
          WHEN CAST(seller.user_type AS TEXT) = 'Team Member' OR tm_record.id IS NOT NULL THEN seller.full_name
          ELSE NULL
        END AS team_member_name,
        CASE 
          WHEN CAST(seller.user_type AS TEXT) = 'Team Member' OR tm_record.id IS NOT NULL THEN COALESCE(tm_record.team_member_uid, seller.member_id)
          ELSE NULL
        END AS team_member_member_id,
        CASE 
          WHEN CAST(seller.user_type AS TEXT) = 'Team Member' OR tm_record.id IS NOT NULL THEN seller.user_id
          ELSE NULL
        END AS team_member_user_id,
        CASE 
          WHEN CAST(seller.user_type AS TEXT) = 'Team Member' OR tm_record.id IS NOT NULL THEN seller.mobile_no
          ELSE NULL
        END AS team_member_mobile,
        CASE 
          WHEN CAST(seller.user_type AS TEXT) = 'Team Member' OR tm_record.id IS NOT NULL THEN seller.email
          ELSE NULL
        END AS team_member_email,

        -- Associate / SOC Details
        b.associate_user_id,
        COALESCE(assoc.full_name, tm_assoc.full_name) AS associate_name,
        COALESCE(assoc.member_id, tm_assoc.member_id) AS associate_member_id,
        COALESCE(assoc.mobile_no, tm_assoc.mobile_no) AS associate_mobile,
        COALESCE(assoc.email, tm_assoc.email) AS associate_email,
        COALESCE(b.associate_user_id, tm_record.associate_id) AS effective_associate_user_id,

        -- Referral ID
        -- For direct customer bookings, show customer's sponsor or Admin referral (MMR00001)
        CASE
          WHEN sponsor.member_id IS NOT NULL THEN sponsor.member_id
          WHEN buyer.sponsor_user_id = 1 OR buyer.sponsor_user_id IS NULL THEN 'MMR00001 (Admin Direct)'
          ELSE ('REF-' || buyer.sponsor_user_id)
        END AS referral_id,
        sponsor.full_name AS sponsor_name,

        -- Plot Details
        p.plot_id,
        p.plot_number,
        COALESCE(p.plot_area, 0) AS plot_area,
        'Gaj' AS area_unit,
        COALESCE(p.plot_status, 'Vacant') AS plot_status,

        -- Site Details
        s.site_id,
        s.site_name,
        COALESCE(s.city, '') AS site_city,

        -- Invoice & Payment Receipt status
        COALESCE(inv.payment_status, CASE WHEN b.advance_amount > 0 THEN 'Advance Received' ELSE 'Unpaid' END) AS payment_status,
        inv.invoice_number,
        COALESCE(inv.paid_amount, b.advance_amount, 0) AS invoice_paid_amount

      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      LEFT JOIN users seller ON seller.user_id = COALESCE(b.sold_by_user_id, b.booked_by_user_id, buyer.referred_by_user_id, buyer.sponsor_user_id)
      LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id
      LEFT JOIN users sponsor ON sponsor.user_id = buyer.sponsor_user_id
      LEFT JOIN LATERAL (
        SELECT full_name
        FROM admin_users
        WHERE admin_id = b.settlement_released_by
        ORDER BY admin_id ASC
        LIMIT 1
      ) rel_admin ON TRUE
      LEFT JOIN LATERAL (
        SELECT id, team_member_uid, associate_id, status
        FROM team_members
        WHERE user_id = COALESCE(b.sold_by_user_id, b.booked_by_user_id, buyer.referred_by_user_id, buyer.sponsor_user_id)
          AND LOWER(status) IN ('approved', 'active')
        ORDER BY created_at DESC
        LIMIT 1
      ) tm_record ON TRUE
      LEFT JOIN LATERAL (
        SELECT full_name, member_id, mobile_no, email
        FROM users
        WHERE user_id = tm_record.associate_id
        LIMIT 1
      ) tm_assoc ON TRUE
      LEFT JOIN LATERAL (
        SELECT invoice_id, invoice_number, payment_status, paid_amount
        FROM invoices
        WHERE booking_id = b.booking_id
        ORDER BY invoice_id DESC
        LIMIT 1
      ) inv ON TRUE
      WHERE ${eligibilityFilter}
        AND ${searchFilter}
        AND ${statusFilter}
        AND ${fromDateFilter}
        AND ${toDateFilter}
      ORDER BY b.booking_id DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    return ok(res, {
      orders,
      metrics,
      pagination: {
        total: metrics.total_orders,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil((metrics.total_orders || 0) / limitNum) || 1
      }
    });
  } catch (e) {
    console.error('[PaymentSettlement] Error loading settlement orders:', e);
    return err(res, e.message || 'Failed to load payment settlement orders', 500);
  }
});

/**
 * Helper to fetch snapshot and calculate recipient-wise commission distribution
 */
async function computeDistributionForBooking(bookingId) {
  const bId = Number(bookingId);
  const [booking] = await sql`
    SELECT b.*, p.plot_id, p.plot_number, p.plot_area, p.base_price AS plot_base_price,
           s.site_name,
           buyer.full_name AS buyer_name, buyer.member_id AS buyer_member_id, buyer.user_id AS buyer_user_id, buyer.sponsor_user_id, buyer.referred_by_user_id,
           seller.full_name AS seller_name, seller.member_id AS seller_member_id, seller.user_type AS seller_user_type, seller.account_status AS seller_account_status,
           assoc.full_name AS associate_name, assoc.member_id AS associate_member_id, assoc.user_type AS associate_user_type, assoc.account_status AS associate_account_status,
           sponsor.member_id AS sponsor_member_id, sponsor.full_name AS sponsor_name
    FROM bookings b
    LEFT JOIN plots p ON p.plot_id = b.plot_id
    LEFT JOIN sites s ON s.site_id = p.site_id
    LEFT JOIN users buyer ON buyer.user_id = b.user_id
    LEFT JOIN users seller ON seller.user_id = b.sold_by_user_id
    LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id
    LEFT JOIN users sponsor ON sponsor.user_id = buyer.sponsor_user_id
    WHERE b.booking_id = ${bId}
    LIMIT 1
  `;

  if (!booking) {
    throw new Error('Booking order not found');
  }

  const engine = await commissionService.getCommissionEngineSnapshot(sql);
  const totalPoolRate = Number(engine.total_commission_percentage ?? 10);
  const sellerPoolShare = Number(engine.seller_percentage ?? 50);
  const teamPoolShare = Number(engine.team_pool_percentage ?? (100 - sellerPoolShare));

  const amountReceived = Number(booking.advance_amount || 0);
  const totalPlotPrice = Number(booking.base_price || booking.sold_price || booking.plot_base_price || (amountReceived + Number(booking.remaining_balance || 0)));

  // Fallback attribution if sold_by_user_id is NULL: check customer's referred_by_user_id or sponsor_user_id
  const effectiveSellerUserId = Number(
    booking.sold_by_user_id ||
    booking.booked_by_user_id ||
    booking.referred_by_user_id ||
    booking.sponsor_user_id ||
    0
  );

  let sellerUser = booking.seller_name ? {
    user_id: booking.sold_by_user_id,
    full_name: booking.seller_name,
    member_id: booking.seller_member_id,
    user_type: booking.seller_user_type,
    account_status: booking.seller_account_status
  } : null;

  if (!sellerUser && effectiveSellerUserId) {
    const [fetched] = await sql`
      SELECT user_id, full_name, member_id, user_type, account_status, sponsor_user_id
      FROM users WHERE user_id = ${effectiveSellerUserId} LIMIT 1
    `;
    if (fetched) sellerUser = fetched;
  }

  // Check if buyer is an enrolled team member in team_members table
  const [buyerTmRow] = await sql`
    SELECT id FROM team_members WHERE user_id = ${booking.user_id} AND LOWER(status) IN ('approved', 'active') LIMIT 1
  `;
  const isBuyerCustomer = (
    booking.buyer_user_type === 'Customer' ||
    !['Team Member', 'Associate', 'Admin', 'SuperAdmin'].includes(booking.buyer_user_type)
  ) && !buyerTmRow && booking.user_id !== effectiveSellerUserId;

  const isSelfPurchase = !isBuyerCustomer || Boolean(
    booking.booking_type === 'SELF_PURCHASE' ||
    (effectiveSellerUserId && booking.user_id === effectiveSellerUserId)
  );
  const isCompanyDirect = !effectiveSellerUserId;

  // Check if booking is cancelled or rejected
  const isBookingCancelled = ['Cancelled', 'Rejected'].includes(booking.booking_status);

  // If already released, fetch historical distribution from plot_order_settlements or commission_transactions
  if (booking.settlement_status === 'Released') {
    const [settlementRecord] = await sql`
      SELECT * FROM plot_order_settlements WHERE booking_id = ${bId} ORDER BY settlement_id DESC LIMIT 1
    `.catch(() => []);

    const wasReleasedWithZeroCommission = Boolean(settlementRecord && Number(settlementRecord.total_distributed || 0) === 0 && !isCompanyDirect);

    // Only lock to historical if it actually distributed OR was a genuine company direct sale
    if (settlementRecord && settlementRecord.recipient_breakdown && !wasReleasedWithZeroCommission) {
      return {
        booking,
        engine,
        amountReceived,
        totalPlotPrice,
        isSelfPurchase,
        isCompanyDirect,
        isBookingCancelled,
        eligibleForRelease: false,
        ineligibleReason: 'Order is already settled and released',
        settlementReference: settlementRecord.settlement_reference,
        settlementStatus: 'Released',
        releasedAt: settlementRecord.created_at || booking.settlement_released_at,
        poolRate: Number(settlementRecord.pool_amount ? ((settlementRecord.pool_amount / amountReceived) * 100).toFixed(2) : totalPoolRate),
        poolAmount: Number(settlementRecord.pool_amount || 0),
        totalDistributionAmount: Number(settlementRecord.total_distributed || 0),
        companyShare: Number(settlementRecord.company_share || 0),
        recipients: settlementRecord.recipient_breakdown,
        isHistorical: true
      };
    }
  }

  // Determine seller & hierarchy
  const sellerUserId = effectiveSellerUserId;
  const [tmSellerRow] = await sql`
    SELECT associate_id, team_member_uid, slot_number
    FROM team_members
    WHERE user_id = ${sellerUserId}
      AND LOWER(status) IN ('approved', 'active')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const isTeamMemberSeller = Boolean(tmSellerRow) || sellerUser?.user_type === 'Team Member';

  // Base rule 1: If company direct, not eligible for payment settlement
  if (isCompanyDirect) {
    return {
      booking,
      engine,
      amountReceived,
      totalPlotPrice,
      isSelfPurchase: false,
      isCompanyDirect: true,
      isTeamMemberSeller: false,
      isBookingCancelled,
      eligibleForRelease: false,
      ineligibleReason: isBookingCancelled ? 'Booking is cancelled/rejected' : 'Company Direct orders are not eligible for payment settlement.',
      settlementStatus: booking.settlement_status || 'Pending',
      poolRate: totalPoolRate,
      poolAmount: 0,
      totalDistributionAmount: 0,
      companyShare: amountReceived,
      recipients: [],
      notes: 'Company Direct Sale: Settlement disabled.'
    };
  }

  // Base rule 2: If self purchase by Associate or Team Member, not eligible for payment settlement
  if (isSelfPurchase) {
    return {
      booking,
      engine,
      amountReceived,
      totalPlotPrice,
      isSelfPurchase: true,
      isCompanyDirect: false,
      isTeamMemberSeller,
      isBookingCancelled,
      eligibleForRelease: false,
      ineligibleReason: isBookingCancelled 
        ? 'Booking is cancelled/rejected' 
        : 'Direct self-purchases by Associates or Team Members are not eligible for payment settlement.',
      settlementStatus: booking.settlement_status || 'Pending',
      poolRate: totalPoolRate,
      poolAmount: 0,
      totalDistributionAmount: 0,
      companyShare: amountReceived,
      recipients: [],
      notes: 'Direct Self-Purchase: Commission settlement disabled.'
    };
  }

  // Base rule 3: Only orders sold through an active Team Member under an Associate Leader are eligible
  if (!isTeamMemberSeller) {
    return {
      booking,
      engine,
      amountReceived,
      totalPlotPrice,
      isSelfPurchase: false,
      isCompanyDirect: false,
      isTeamMemberSeller: false,
      isBookingCancelled,
      eligibleForRelease: false,
      ineligibleReason: 'Only plot orders sold through an active Team Member under an Associate Leader are eligible for payment settlement.',
      settlementStatus: booking.settlement_status || 'Pending',
      poolRate: totalPoolRate,
      poolAmount: 0,
      totalDistributionAmount: 0,
      companyShare: amountReceived,
      recipients: [],
      notes: 'Direct Associate Sale (without Team Member): Settlement disabled.'
    };
  }
  let leaderUserId = isTeamMemberSeller
    ? Number(tmSellerRow?.associate_id || booking.associate_user_id || booking.seller_sponsor_user_id || sellerUser?.sponsor_user_id || 0)
    : sellerUserId;

  if (isTeamMemberSeller && (!leaderUserId || leaderUserId === sellerUserId)) {
    const [sellerUserRow] = await sql`
      SELECT sponsor_user_id, referred_by_user_id FROM users WHERE user_id = ${sellerUserId} LIMIT 1
    `;
    const fallbackLeader = Number(sellerUserRow?.sponsor_user_id || sellerUserRow?.referred_by_user_id || 0);
    if (fallbackLeader > 0) {
      leaderUserId = fallbackLeader;
    }
  }

  // Active enrolled team members under the associate leader
  const teamRows = leaderUserId
    ? await sql`
        SELECT DISTINCT tm.user_id, tm.team_member_uid, tm.full_name, tm.mobile_no,
               COALESCE(u.account_status, 'Active') AS account_status, u.member_id
        FROM team_members tm
        LEFT JOIN users u ON tm.user_id = u.user_id
        WHERE tm.associate_id = ${leaderUserId}
          AND LOWER(tm.status) IN ('approved', 'active')
          AND tm.user_id IS NOT NULL
      `
    : [];

  const eligibleTeamMembers = teamRows.filter((m) => {
    if (Number(m.user_id) === sellerUserId) return false;
    const isMemberActive = ['Active', 'Approved'].includes(m.account_status);
    return isMemberActive && m.account_status !== 'Blacklisted';
  });

  // Prepare participants
  const remainingParticipants = [];
  let associateLeaderRecipient = null;

  if (isTeamMemberSeller) {
    if (leaderUserId && leaderUserId !== sellerUserId) {
      const [leaderUser] = await sql`
        SELECT user_id, full_name, member_id, account_status, user_type
        FROM users
        WHERE user_id = ${leaderUserId}
          AND CAST(user_type AS TEXT) = 'Associate'
      `;
      const isLeaderActive = leaderUser && ['Active', 'Approved'].includes(leaderUser.account_status) && leaderUser.account_status !== 'Blacklisted';
      if (isLeaderActive) {
        associateLeaderRecipient = {
          user_id: leaderUserId,
          name: leaderUser.full_name,
          member_id: leaderUser.member_id || `MMR-ASC-${leaderUserId}`,
          user_type: 'Associate',
          role: 'AssociateLeader',
          role_label: 'Supervising Associate (Leader)'
        };
        remainingParticipants.push(associateLeaderRecipient);
      }
    }

    for (const tm of eligibleTeamMembers) {
      remainingParticipants.push({
        user_id: Number(tm.user_id),
        name: tm.full_name,
        member_id: tm.member_id || tm.team_member_uid,
        user_type: 'Team Member',
        role: 'TeamMember',
        role_label: 'Enrolled Team Member'
      });
    }
  } else {
    // Seller is Associate Leader
    for (const tm of eligibleTeamMembers) {
      remainingParticipants.push({
        user_id: Number(tm.user_id),
        name: tm.full_name,
        member_id: tm.member_id || tm.team_member_uid,
        user_type: 'Team Member',
        role: 'TeamMember',
        role_label: 'Enrolled Team Member'
      });
    }
  }

  const participantCount = remainingParticipants.length;

  // Use pure canonical math from commissionService
  const math = commissionService.calculateCommissionDistribution({
    baseAmount: amountReceived,
    totalPoolRate,
    sellerPoolShare,
    teamPoolShare,
    participantsCount: participantCount,
    isTeamMemberSeller
  });

  const recipients = [];

  // 1. Direct Seller
  if (math.sellerAmount > 0) {
    recipients.push({
      user_id: sellerUserId,
      name: sellerUser?.full_name || booking.seller_name || 'Seller',
      member_id: isTeamMemberSeller ? (tmSellerRow?.team_member_uid || sellerUser?.member_id || booking.seller_member_id) : (sellerUser?.member_id || booking.seller_member_id),
      user_type: isTeamMemberSeller ? 'Team Member' : 'Associate',
      role: isTeamMemberSeller ? 'Seller (Team Member)' : 'Seller (Associate)',
      role_label: isTeamMemberSeller ? 'Direct Seller (T Member)' : 'Direct Seller (Associate)',
      amount: math.sellerAmount,
      percentage: Math.round(((totalPoolRate * sellerPoolShare) / 100) * 100) / 100
    });
  }

  // 2. Team Participants
  if (participantCount > 0 && math.remainingPoolAmount > 0) {
    const eachPercentage = Math.round((((totalPoolRate * teamPoolShare) / 100) / participantCount) * 100) / 100;
    for (const p of remainingParticipants) {
      const payout = (p.role === 'AssociateLeader' && math.associateShareAmount > 0)
        ? math.associateShareAmount
        : math.eachShareAmount;

      if (payout > 0) {
        recipients.push({
          user_id: p.user_id,
          name: p.name,
          member_id: p.member_id,
          user_type: p.user_type,
          role: p.role,
          role_label: p.role_label,
          amount: payout,
          percentage: eachPercentage
        });
      }
    }
  }

  const companyShareFromReceived = Math.max(0, Number((amountReceived - math.totalDistributedAmount).toFixed(2)));
  const companyRetainedTotal = Number((totalPlotPrice - math.totalDistributedAmount).toFixed(2));

  const wasReleasedWithZeroCommission = Boolean(booking.settlement_status === 'Released' && !isCompanyDirect);
  const eligibleForRelease = !isBookingCancelled && amountReceived > 0 && (booking.settlement_status !== 'Released' || wasReleasedWithZeroCommission);
  let ineligibleReason = null;
  if (booking.settlement_status === 'Released' && !wasReleasedWithZeroCommission) ineligibleReason = 'Settlement has already been released';
  else if (isBookingCancelled) ineligibleReason = 'Booking order is cancelled or rejected';
  else if (amountReceived <= 0) ineligibleReason = 'No advance or payment received yet for this order';

  return {
    booking,
    engine,
    amountReceived,
    totalPlotPrice,
    isSelfPurchase: false,
    isCompanyDirect: false,
    isBookingCancelled,
    eligibleForRelease,
    ineligibleReason,
    settlementStatus: booking.settlement_status || 'Pending',
    poolRate: totalPoolRate,
    poolAmount: math.poolAmount,
    totalDistributionAmount: math.totalDistributedAmount,
    undistributedAmount: math.undistributedAmount,
    companyShareFromReceived,
    companyRetainedTotal,
    recipients,
    participantsCount: participantCount,
    sellerUserId,
    isTeamMemberSeller,
    leaderUserId
  };
}

/**
 * 2. GET /api/admin/payment-settlements/:id/preview
 * Returns full recipient-wise breakdown before final release confirmation.
 */
router.get(['/admin/payment-settlements/:id/preview', '/api/admin/payment-settlements/:id/preview'], verifyAdminToken, async (req, res) => {
  try {
    await ensureSettlementSchema();
    const bookingId = Number(req.params.id);
    if (!bookingId || bookingId <= 0) return err(res, 'Invalid booking order ID', 400);

    const calculation = await computeDistributionForBooking(bookingId);
    return ok(res, calculation, 'Settlement preview calculated successfully');
  } catch (e) {
    console.error('[PaymentSettlement] Preview error:', e);
    return err(res, e.message || 'Failed to calculate settlement preview', 500);
  }
});

/**
 * 3. POST /api/admin/payment-settlements/:id/release
 * Authorizes and records payment settlement & commission distribution with strict transaction isolation.
 */
router.post(
  ['/admin/payment-settlements/:id/release', '/api/admin/payment-settlements/:id/release'],
  verifyAdminToken,
  role('SuperAdmin', 'Admin', 'FinanceManager'),
  async (req, res) => {
    try {
      await ensureSettlementSchema();
      const bookingId = Number(req.params.id);
      const { remarks = '', payment_mode = 'Internal Ledger Settlement' } = req.body || {};

      if (!bookingId || bookingId <= 0) return err(res, 'Invalid booking ID', 400);

      const adminId = req.admin?.admin_id || req.user?.admin_id || 1;
      const adminName = req.admin?.username || req.admin?.full_name || 'Admin';

      // Execute within database transaction with advisory lock
      const result = await sql.begin(async (tx) => {
        // 1. Transaction Advisory Lock on booking
        await tx`SELECT pg_advisory_xact_lock(${bookingId})`;

        // 2. Fetch current booking status under transaction
        const [booking] = await tx`
          SELECT b.*, p.plot_id, p.plot_number, p.sold_price, p.base_price AS plot_base_price,
                 s.site_name,
                 buyer.full_name AS buyer_name, buyer.member_id AS buyer_member_id
          FROM bookings b
          LEFT JOIN plots p ON p.plot_id = b.plot_id
          LEFT JOIN sites s ON s.site_id = p.site_id
          LEFT JOIN users buyer ON buyer.user_id = b.user_id
          WHERE b.booking_id = ${bookingId}
          FOR UPDATE OF b
        `;

        if (!booking) {
          throw new Error('Booking order not found');
        }

        if (booking.settlement_status === 'Released') {
          const [prevStl] = await tx`
            SELECT total_distributed FROM plot_order_settlements
            WHERE booking_id = ${bookingId} ORDER BY settlement_id DESC LIMIT 1
          `.catch(() => []);
          const wasEmptyRelease = Boolean(prevStl && Number(prevStl.total_distributed || 0) === 0);
          if (!wasEmptyRelease) {
            throw new Error(`Order #${bookingId} has already been settled and released on ${booking.settlement_released_at || 'earlier date'}.`);
          }
        }

        if (['Cancelled', 'Rejected'].includes(booking.booking_status)) {
          throw new Error(`Cannot release settlement for an order that is ${booking.booking_status}.`);
        }

        const amountReceived = Number(booking.advance_amount || 0);
        if (amountReceived <= 0) {
          throw new Error('No payment received by company for this order. Settlement cannot be released.');
        }

        // 3. Compute distribution
        const calculation = await computeDistributionForBooking(bookingId);

        if (!calculation.eligibleForRelease && !calculation.isHistorical) {
          throw new Error(calculation.ineligibleReason || 'This order is not eligible for payment settlement release.');
        }

        if (calculation.isSelfPurchase || calculation.isCompanyDirect || !calculation.isTeamMemberSeller) {
          throw new Error(calculation.ineligibleReason || 'Settlement release is only permitted for customer orders sold through an active Team Member under an Associate Leader.');
        }

        // Ensure settlement reference is unique (handles re-distribution of previously released orders)
        let settlementRef = `MMR-STL-${new Date().getFullYear()}-${String(bookingId).padStart(6, '0')}`;
        const [existingRef] = await tx`
          SELECT settlement_id FROM plot_order_settlements WHERE settlement_reference = ${settlementRef} LIMIT 1
        `.catch(() => []);
        if (existingRef) {
          settlementRef = `MMR-STL-${new Date().getFullYear()}-${String(bookingId).padStart(6, '0')}-R${Date.now().toString().slice(-4)}`;
        }

        // 4. If booking has an attributed seller, generate canonical commission records
        if (!calculation.isCompanyDirect && !calculation.isSelfPurchase && calculation.totalDistributionAmount > 0) {
          // Persist attribution in bookings table if missing
          if ((!booking.sold_by_user_id || !booking.associate_user_id) && calculation.sellerUserId) {
            await tx`
              UPDATE bookings
              SET sold_by_user_id = COALESCE(sold_by_user_id, ${calculation.sellerUserId}),
                  associate_user_id = COALESCE(associate_user_id, ${calculation.leaderUserId || null}),
                  updated_at = NOW()
              WHERE booking_id = ${bookingId}
            `;
          }

          await commissionService.generateCommissionForPayment({
            bookingId,
            event: {
              type: 'BookingAdvance',
              key: `settlement:${bookingId}:${Date.now()}`,
              principalAmount: amountReceived,
              sourceRef: settlementRef,
              paymentType: booking.payment_type || 'Standard'
            },
            adminId,
            db: tx
          });

          // Ensure columns exist on commission_transactions before updating
          await tx`
            ALTER TABLE commission_transactions
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS approved_by_admin_id INT,
            ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS payment_reference TEXT,
            ADD COLUMN IF NOT EXISTS notes TEXT
          `.catch(() => {});

          // Mark corresponding commission transactions as Approved/Paid under this settlement reference
          await tx`
            UPDATE commission_transactions
            SET commission_status = 'Approved',
                approved_by_admin_id = ${adminId},
                approved_at = NOW(),
                paid_at = NOW(),
                payment_reference = ${settlementRef},
                updated_at = NOW()
            WHERE related_booking_id = ${bookingId}
              AND commission_status IN ('Pending', 'Approved')
          `;

          // Credit recipients' user_wallets and create wallet_transactions ledger entries
          for (const recipient of calculation.recipients) {
            if (recipient.user_id && recipient.amount > 0) {
              const recRole = recipient.user_type || (recipient.role?.includes('Team Member') || recipient.role === 'TeamMember' ? 'Team Member' : 'Associate');
              
              // 1. Upsert wallet and retrieve updated row with lock
              let [wallet] = await tx`
                SELECT * FROM user_wallets WHERE user_id = ${recipient.user_id} FOR UPDATE
              `.catch(() => []);

              let balanceBefore = 0;
              let balanceAfter = recipient.amount;

              if (!wallet) {
                [wallet] = await tx`
                  INSERT INTO user_wallets (user_id, user_role, available_balance, pending_withdrawal_balance, total_added_fund, total_withdrawn, total_commission)
                  VALUES (${recipient.user_id}, ${recRole}, ${recipient.amount}, 0.00, 0.00, 0.00, ${recipient.amount})
                  RETURNING *
                `;
                balanceBefore = 0;
                balanceAfter = Number(wallet.available_balance);
              } else {
                balanceBefore = Number(wallet.available_balance);
                balanceAfter = balanceBefore + Number(recipient.amount);
                const newTotalCommission = Number(wallet.total_commission || 0) + Number(recipient.amount);

                [wallet] = await tx`
                  UPDATE user_wallets SET
                    available_balance = ${balanceAfter},
                    total_commission = ${newTotalCommission},
                    user_role = ${recRole},
                    updated_at = NOW()
                  WHERE id = ${wallet.id}
                  RETURNING *
                `;
              }

              // 2. Insert ledger into wallet_transactions adhering to all schema constraints
              await tx`
                INSERT INTO wallet_transactions (
                  wallet_id, user_id, user_role, transaction_type, source,
                  amount, balance_before, balance_after, payment_order_id,
                  status, remarks, created_at
                ) VALUES (
                  ${wallet.id}, ${recipient.user_id}, ${recRole},
                  'credit', 'Commission Settlement', ${recipient.amount},
                  ${balanceBefore}, ${balanceAfter}, ${settlementRef},
                  'success', ${'Commission settlement for Booking #' + (booking.booking_serial || bookingId)}, NOW()
                )
              `.catch((txErr) => {
                console.error(`[PaymentSettlement] Wallet transaction insert error for user ${recipient.user_id}:`, txErr.message);
              });
            }
          }
        }

        // 5. Update bookings table
        const auditEntry = {
          action: 'RELEASE_SETTLEMENT',
          admin_id: adminId,
          admin_name: adminName,
          timestamp: new Date().toISOString(),
          settlement_reference: settlementRef,
          amount_received: amountReceived,
          total_distributed: calculation.totalDistributionAmount,
          company_share: calculation.companyShareFromReceived,
          recipient_count: calculation.recipients.length,
          remarks: remarks || 'Authorized release by Admin'
        };

        const existingAuditLog = Array.isArray(booking.settlement_audit_log) ? booking.settlement_audit_log : [];
        existingAuditLog.push(auditEntry);

        const [updatedBooking] = await tx`
          UPDATE bookings
          SET
            settlement_status = 'Released',
            settlement_released_at = NOW(),
            settlement_released_by = ${adminId},
            settlement_reference = ${settlementRef},
            settlement_audit_log = ${tx.json(existingAuditLog)}
          WHERE booking_id = ${bookingId}
          RETURNING *
        `;

        // 6. Record immutable settlement in plot_order_settlements table (upsert safe)
        await tx`
          INSERT INTO plot_order_settlements (
            booking_id, settlement_reference, admin_id, admin_name,
            total_plot_price, amount_received, pool_amount, total_distributed, company_share,
            recipient_breakdown, previous_status, new_status, notes
          ) VALUES (
            ${bookingId}, ${settlementRef}, ${adminId}, ${adminName},
            ${calculation.totalPlotPrice}, ${amountReceived}, ${calculation.poolAmount},
            ${calculation.totalDistributionAmount}, ${calculation.companyShareFromReceived},
            ${tx.json(calculation.recipients)},
            ${booking.settlement_status || 'Pending'}, 'Released',
            ${remarks || 'Authorized settlement release'}
          )
          ON CONFLICT (settlement_reference) DO UPDATE SET
            admin_id = EXCLUDED.admin_id,
            admin_name = EXCLUDED.admin_name,
            total_plot_price = EXCLUDED.total_plot_price,
            amount_received = EXCLUDED.amount_received,
            pool_amount = EXCLUDED.pool_amount,
            total_distributed = EXCLUDED.total_distributed,
            company_share = EXCLUDED.company_share,
            recipient_breakdown = EXCLUDED.recipient_breakdown,
            new_status = EXCLUDED.new_status,
            notes = EXCLUDED.notes,
            created_at = NOW()
        `;

        return {
          booking: updatedBooking,
          settlement_reference: settlementRef,
          amount_received: amountReceived,
          total_distributed: calculation.totalDistributionAmount,
          company_share: calculation.companyShareFromReceived,
          recipients: calculation.recipients,
          settlement_type: 'Authorized Settlement Instruction (Internal Ledger / Wallet Credit)',
          released_at: new Date().toISOString(),
          admin_name: adminName
        };
      });

      // Standalone Commission Settlement Release Email Dispatch
      triggerCommissionSettlementEmailsAsync(
        bookingId,
        {
          settlementReference: result.settlement_reference,
          bookingSerial: result.booking?.booking_serial,
          plotNumber: result.booking?.plot_number,
          siteName: result.booking?.site_name,
          customerName: result.booking?.buyer_name,
          adminName: result.admin_name,
          releasedAt: result.released_at
        },
        result.recipients
      );

      return ok(
        res,
        result,
        `Payment settlement #${result.settlement_reference} released successfully.`
      );
    } catch (e) {
      console.error('[PaymentSettlement] Release error:', e);
      return err(res, e.message || 'Failed to release payment settlement', 400);
    }
  }
);

/**
 * 4. POST /api/admin/payment-settlements/:id/cancel
 * Cancels a settlement request with audit logging and safeguards.
 */
router.post(
  ['/admin/payment-settlements/:id/cancel', '/api/admin/payment-settlements/:id/cancel'],
  verifyAdminToken,
  role('SuperAdmin', 'Admin', 'FinanceManager'),
  async (req, res) => {
    try {
      await ensureSettlementSchema();
      const bookingId = Number(req.params.id);
      const { reason = '' } = req.body || {};

      if (!bookingId || bookingId <= 0) return err(res, 'Invalid booking ID', 400);
      if (!String(reason).trim()) return err(res, 'Cancellation reason is mandatory', 400);

      const adminId = req.admin?.admin_id || req.user?.admin_id || 1;
      const adminName = req.admin?.username || req.admin?.full_name || 'Admin';

      const result = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${bookingId})`;

        const [booking] = await tx`
          SELECT * FROM bookings WHERE booking_id = ${bookingId} FOR UPDATE
        `;

        if (!booking) throw new Error('Booking order not found');

        if (booking.settlement_status === 'Released') {
          throw new Error('Cannot cancel an already released settlement. A formal reversal workflow is required.');
        }

        if (booking.settlement_status === 'Cancelled') {
          throw new Error('Settlement is already cancelled.');
        }

        const auditEntry = {
          action: 'CANCEL_SETTLEMENT',
          admin_id: adminId,
          admin_name: adminName,
          timestamp: new Date().toISOString(),
          reason: reason.trim(),
          previous_status: booking.settlement_status || 'Pending'
        };

        const existingAuditLog = Array.isArray(booking.settlement_audit_log) ? booking.settlement_audit_log : [];
        existingAuditLog.push(auditEntry);

        const [updatedBooking] = await tx`
          UPDATE bookings
          SET
            settlement_status = 'Cancelled',
            settlement_cancelled_at = NOW(),
            settlement_cancelled_by = ${adminId},
            settlement_cancel_reason = ${reason.trim()},
            settlement_audit_log = ${tx.json(existingAuditLog)}
          WHERE booking_id = ${bookingId}
          RETURNING *
        `;

        // Cancel any pending commission records
        await commissionService.cancelBookingCommissions(tx, {
          bookingId,
          reason: `Settlement cancelled by admin: ${reason.trim()}`
        });

        return updatedBooking;
      });

      return ok(res, result, `Settlement for order #${bookingId} has been cancelled.`);
    } catch (e) {
      console.error('[PaymentSettlement] Cancel error:', e);
      return err(res, e.message || 'Failed to cancel settlement', 400);
    }
  }
);

export default router;
