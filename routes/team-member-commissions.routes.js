import express from 'express';
import sql from '../db.js';
import { verifyUserToken } from '../middleware/auth.middleware.js';

const router = express.Router();

const ok = (res, data, message = 'Success', extra = {}) =>
  res.status(200).json({ success: true, message, data, ...extra });

const err = (res, message = 'Server error', status = 500) =>
  res.status(status).json({ success: false, message });

/**
 * Verify caller is Team Member or Admin
 */
function requireTeamMember(req, res, next) {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const role = user.user_type || user.role;
  const isTm = role === 'Team Member' || role === 'TeamMember' || user.is_team_member;
  const isAdmin = user.is_admin || ['Admin', 'SuperAdmin', 'FinanceManager', 'SiteManager'].includes(role);

  if (!isTm && !isAdmin) {
    return res.status(403).json({ success: false, message: 'Forbidden — Team Member privileges required' });
  }

  next();
}

/**
 * Helper: ensure wallet row exists
 */
async function getOrCreateTmWallet(userId, tx = sql) {
  const [existing] = await tx`
    SELECT * FROM user_wallets WHERE user_id = ${userId}
  `;
  if (existing) return existing;

  const [created] = await tx`
    INSERT INTO user_wallets (
      user_id, user_role, available_balance, pending_withdrawal_balance,
      total_added_fund, total_withdrawn, total_commission
    ) VALUES (
      ${userId}, 'Team Member', 0.00, 0.00, 0.00, 0.00, 0.00
    )
    ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
    RETURNING *
  `;
  return created;
}

/**
 * 1. GET /api/team-member/commission-summary
 * Returns KPI summary for Dashboard & Commissions page
 */
router.get(['/team-member/commission-summary', '/api/team-member/commission-summary'], verifyUserToken, requireTeamMember, async (req, res) => {
  try {
    const userId = Number(req.user.user_id);
    const wallet = await getOrCreateTmWallet(userId);

    // Settled Commission: From user_wallets or commission_transactions with Approved/Paid
    const [settledTx] = await sql`
      SELECT COALESCE(SUM(c.net_amount), 0)::numeric AS settled_commission
      FROM commission_transactions c
      WHERE c.associate_user_id = ${userId}
        AND c.commission_status IN ('Approved', 'Paid')
    `;

    // Pending Commission: Commission from attributed bookings where settlement_status is 'Pending'
    // and booking is valid (not Cancelled/Rejected)
    const [pendingBookingComms] = await sql`
      SELECT 
        COALESCE(SUM(
          CASE 
            WHEN c.net_amount IS NOT NULL THEN c.net_amount
            ELSE ROUND(COALESCE(b.base_price, p.sold_price, p.base_price, (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0) * 0.05, 2)
          END
        ), 0)::numeric AS pending_commission
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN LATERAL (
        SELECT cx.net_amount 
        FROM commission_transactions cx 
        WHERE cx.related_booking_id = b.booking_id 
          AND cx.associate_user_id = ${userId} 
        LIMIT 1
      ) c ON TRUE
      WHERE (b.sold_by_user_id = ${userId} OR c.net_amount IS NOT NULL)
        AND COALESCE(b.settlement_status, 'Pending') = 'Pending'
        AND b.booking_status NOT IN ('Cancelled', 'Rejected')
    `;

    const totalEarned = Math.max(
      Number(wallet.total_commission || 0),
      Number(settledTx?.settled_commission || 0)
    );

    const pendingCommission = Number(pendingBookingComms?.pending_commission || 0);
    const availableBalance = Number(wallet.available_balance || 0);
    const totalWithdrawn = Number(wallet.total_withdrawn || 0);
    const pendingWithdrawal = Number(wallet.pending_withdrawal_balance || 0);

    return ok(res, {
      total_commission_earned: totalEarned,
      pending_commission: pendingCommission,
      available_balance: availableBalance,
      withdrawn_amount: totalWithdrawn,
      total_withdrawn: totalWithdrawn,
      pending_withdrawal_balance: pendingWithdrawal
    }, 'Team member commission summary loaded.');
  } catch (e) {
    console.error('[GET /team-member/commission-summary Error]', e);
    return err(res, e.message || 'Failed to load commission summary');
  }
});

/**
 * 2. GET /api/team-member/commissions
 * Returns full historical commission breakdown with search, date range, status filters, and pagination
 */
router.get(['/team-member/commissions', '/api/team-member/commissions'], verifyUserToken, requireTeamMember, async (req, res) => {
  try {
    const userId = Number(req.user.user_id);
    const {
      search = '',
      from_date = '',
      to_date = '',
      status = 'ALL',
      sort_by = 'booking_date',
      order = 'DESC',
      page = 1,
      limit = 15
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 15));
    const offset = (pageNum - 1) * limitNum;

    // Search condition
    const q = String(search || '').trim();
    const searchFilter = q ? sql`
      (
        b.booking_serial ILIKE ${'%' + q + '%'}
        OR buyer.full_name ILIKE ${'%' + q + '%'}
        OR buyer.member_id ILIKE ${'%' + q + '%'}
        OR buyer.mobile_no ILIKE ${'%' + q + '%'}
        OR p.plot_number ILIKE ${'%' + q + '%'}
        OR s.site_name ILIKE ${'%' + q + '%'}
      )
    ` : sql`TRUE`;

    // Date range
    const fromDateFilter = from_date ? sql`b.created_at >= ${from_date}::timestamptz` : sql`TRUE`;
    const toDateFilter = to_date ? sql`b.created_at <= (${to_date}::date + INTERVAL '1 day')::timestamptz` : sql`TRUE`;

    // Status Filter (ALL / Pending / Settled / Cancelled)
    const statusNorm = String(status || 'ALL').toUpperCase();
    const statusFilter = statusNorm === 'ALL'
      ? sql`TRUE`
      : statusNorm === 'SETTLED' || statusNorm === 'RELEASED'
        ? sql`b.settlement_status = 'Released'`
        : statusNorm === 'CANCELLED'
          ? sql`b.settlement_status = 'Cancelled'`
          : sql`COALESCE(b.settlement_status, 'Pending') = 'Pending'`;

    // Eligible bookings for this Team Member (sold by user or received commission)
    const records = await sql`
      SELECT
        b.booking_id,
        b.booking_serial,
        COALESCE(b.booking_date, b.created_at) AS booking_date,
        b.booking_status,
        b.advance_amount,
        COALESCE(b.base_price, p.sold_price, p.base_price, (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0) AS plot_total_price,
        
        -- Plot and Site
        p.plot_number,
        COALESCE(p.plot_area, 0) AS plot_area,
        s.site_name,
        
        -- Customer Details
        buyer.user_id AS customer_user_id,
        buyer.full_name AS customer_name,
        buyer.member_id AS customer_member_id,
        buyer.mobile_no AS customer_mobile,

        -- Settlement Attributes
        COALESCE(b.settlement_status, 'Pending') AS raw_settlement_status,
        CASE
          WHEN b.settlement_status = 'Released' THEN 'Settled'
          WHEN b.settlement_status = 'Cancelled' THEN 'Cancelled'
          ELSE 'Pending'
        END AS settlement_status,
        b.settlement_released_at AS settlement_date,
        b.settlement_reference,

        -- Commission Details
        COALESCE(c.commission_id, 0) AS commission_id,
        COALESCE(c.commission_percentage, 5.00) AS commission_percentage,
        COALESCE(
          c.net_amount,
          ROUND(COALESCE(b.base_price, p.sold_price, p.base_price, (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0) * 0.05, 2)
        ) AS commission_amount,
        COALESCE(c.commission_status, CASE WHEN b.settlement_status = 'Released' THEN 'Approved' ELSE 'Pending' END) AS commission_status,
        CASE
          WHEN b.sold_by_user_id = ${userId} THEN 'Direct Seller'
          ELSE 'Team Participant'
        END AS distribution_role

      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      LEFT JOIN LATERAL (
        SELECT cx.commission_id, cx.commission_percentage, cx.net_amount, cx.commission_status, cx.paid_at
        FROM commission_transactions cx
        WHERE cx.related_booking_id = b.booking_id
          AND cx.associate_user_id = ${userId}
        ORDER BY cx.commission_id DESC
        LIMIT 1
      ) c ON TRUE
      WHERE (b.sold_by_user_id = ${userId} OR c.commission_id IS NOT NULL)
        AND b.booking_status NOT IN ('Draft')
        AND ${searchFilter}
        AND ${fromDateFilter}
        AND ${toDateFilter}
        AND ${statusFilter}
      ORDER BY 
        CASE WHEN ${sort_by} = 'amount' THEN COALESCE(c.net_amount, 0) END DESC,
        CASE WHEN ${sort_by} = 'customer' THEN buyer.full_name END ASC,
        b.booking_id DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    // Total Count for Pagination
    const [totalRow] = await sql`
      SELECT COUNT(*)::int AS count
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      LEFT JOIN LATERAL (
        SELECT cx.commission_id, cx.net_amount
        FROM commission_transactions cx
        WHERE cx.related_booking_id = b.booking_id
          AND cx.associate_user_id = ${userId}
        LIMIT 1
      ) c ON TRUE
      WHERE (b.sold_by_user_id = ${userId} OR c.commission_id IS NOT NULL)
        AND b.booking_status NOT IN ('Draft')
        AND ${searchFilter}
        AND ${fromDateFilter}
        AND ${toDateFilter}
        AND ${statusFilter}
    `;

    const totalCount = Number(totalRow?.count || 0);

    // Summary KPIs for Top Cards
    const wallet = await getOrCreateTmWallet(userId);
    const [pendingBookingComms] = await sql`
      SELECT COALESCE(SUM(
        CASE 
          WHEN c.net_amount IS NOT NULL THEN c.net_amount
          ELSE ROUND(COALESCE(b.base_price, p.sold_price, p.base_price, (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0) * 0.05, 2)
        END
      ), 0)::numeric AS pending_commission
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN LATERAL (
        SELECT cx.net_amount 
        FROM commission_transactions cx 
        WHERE cx.related_booking_id = b.booking_id 
          AND cx.associate_user_id = ${userId} 
        LIMIT 1
      ) c ON TRUE
      WHERE (b.sold_by_user_id = ${userId} OR c.net_amount IS NOT NULL)
        AND COALESCE(b.settlement_status, 'Pending') = 'Pending'
        AND b.booking_status NOT IN ('Cancelled', 'Rejected')
    `;

    return ok(res, {
      commissions: records,
      summary: {
        total_commission_earned: Number(wallet.total_commission || 0),
        pending_commission: Number(pendingBookingComms?.pending_commission || 0),
        available_balance: Number(wallet.available_balance || 0),
        withdrawn_amount: Number(wallet.total_withdrawn || 0),
        pending_withdrawal_balance: Number(wallet.pending_withdrawal_balance || 0)
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: Math.ceil(totalCount / limitNum) || 1
      }
    }, 'Team member commission history loaded successfully.');
  } catch (e) {
    console.error('[GET /team-member/commissions Error]', e);
    return err(res, e.message || 'Failed to load commissions');
  }
});

/**
 * 3. GET /api/team-member/sales
 * Team member sales with commission amount and settlement status attached
 */
router.get(['/team-member/sales', '/api/team-member/sales'], verifyUserToken, requireTeamMember, async (req, res) => {
  try {
    const userId = Number(req.user.user_id);
    const { page = 1, limit = 50, search = '' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    const q = String(search || '').trim();
    const searchFilter = q ? sql`
      (
        b.booking_serial ILIKE ${'%' + q + '%'}
        OR buyer.full_name ILIKE ${'%' + q + '%'}
        OR buyer.mobile_no ILIKE ${'%' + q + '%'}
        OR p.plot_number ILIKE ${'%' + q + '%'}
        OR s.site_name ILIKE ${'%' + q + '%'}
      )
    ` : sql`TRUE`;

    const sales = await sql`
      SELECT
        b.booking_id,
        b.booking_serial,
        b.booking_status,
        b.associate_approval_status,
        b.booking_type,
        CASE WHEN b.booking_type = 'SELF_PURCHASE' THEN 'SELF_PURCHASE' ELSE 'CUSTOMER_SALE' END AS sale_type,
        COALESCE(b.advance_amount, 0) AS advance_amount,
        COALESCE(b.base_price, p.sold_price, p.base_price, (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0) AS total_plot_price,
        COALESCE(b.booking_date, b.created_at) AS created_at,
        p.plot_number,
        COALESCE(p.plot_area, 0) AS plot_size_gaj,
        s.site_name,
        buyer.full_name AS customer_name,
        buyer.mobile_no AS customer_mobile,
        buyer.member_id AS customer_member_id,
        
        -- Settlement & Commission details
        COALESCE(b.settlement_status, 'Pending') AS settlement_status,
        b.settlement_released_at,
        COALESCE(
          c.net_amount,
          ROUND(COALESCE(b.base_price, p.sold_price, p.base_price, (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0) * 0.05, 2)
        ) AS commission_amount
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      LEFT JOIN LATERAL (
        SELECT cx.net_amount
        FROM commission_transactions cx
        WHERE cx.related_booking_id = b.booking_id
          AND cx.associate_user_id = ${userId}
        LIMIT 1
      ) c ON TRUE
      WHERE b.sold_by_user_id = ${userId}
        AND b.booking_status NOT IN ('Draft')
        AND ${searchFilter}
      ORDER BY b.booking_id DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const [totalRow] = await sql`
      SELECT COUNT(*)::int AS count
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      WHERE b.sold_by_user_id = ${userId}
        AND b.booking_status NOT IN ('Draft')
        AND ${searchFilter}
    `;

    return ok(res, sales, 'Team member sales retrieved successfully.', {
      total: Number(totalRow?.count || 0),
      page: pageNum,
      limit: limitNum
    });
  } catch (e) {
    console.error('[GET /team-member/sales Error]', e);
    return err(res, e.message || 'Failed to load team member sales');
  }
});

export default router;
