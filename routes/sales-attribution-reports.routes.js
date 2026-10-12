/**
 * MMR Construction & Developers Pvt. Ltd.
 * Sales Attribution & Leaderboard Reporting APIs (Phase 2)
 *
 * Endpoints:
 * 1. GET /api/team-members/:id/sales-summary
 * 2. GET /api/team-members/:id/customers-sales
 * 3. GET /api/associates/:id/team-sales
 * 4. GET /api/associates/:id/team-sales/export
 * 5. GET /api/admin/leaderboard/team-members
 * 6. GET /api/admin/leaderboard/team-members/export
 * 7. GET /api/admin/leaderboard/associates
 * 8. GET /api/admin/leaderboard/associates/export
 * 9. GET /api/admin/leaderboard/associates/:id/drilldown
 * 10. GET /api/admin/sales-attribution/export
 * 11. GET /api/admin/sales-attribution/unattributed
 */

import express from 'express';
import sql from '../db.js';
import { verifyUserToken, verifyAdminToken, role, resolveEffectivePanel } from '../middleware/auth.middleware.js';

const router = express.Router();

function ok(res, data = null, message = 'Success', extra = {}) {
  return res.json({ success: true, message, data, ...extra });
}

function err(res, message = 'Error', code = 400) {
  return res.status(code).json({ success: false, message });
}

function escapeCsvCell(val) {
  if (val === null || val === undefined) return '""';
  let s = String(val).replace(/"/g, '""');
  if (/^[=+\-@]/.test(s)) {
    s = "'" + s;
  }
  return `"${s}"`;
}

/**
 * 1. GET /api/team-members/:id/sales-summary
 * Summary KPI counts & volumes for a specific Team Member
 */
router.get('/team-members/:id/sales-summary', verifyUserToken, async (req, res) => {
  try {
    const targetTmId = Number(req.params.id);
    const [caller] = await sql`SELECT user_id, user_type, account_status FROM users WHERE user_id = ${req.user.user_id}`;
    if (!caller || !['Active', 'Approved'].includes(caller.account_status)) {
      return err(res, 'Access denied: Active account required.', 403);
    }
    const callerId = caller.user_id;
    const effectivePanel = resolveEffectivePanel(req.user);
    const callerType = effectivePanel === 'team-member' ? 'Team Member' : caller.user_type;

    // Security Guard: Team Member can only view their own summary; Associate can view their TM's summary; Admin can view all
    if (callerType === 'Team Member' && callerId !== targetTmId) {
      return err(res, 'Access denied: You can only view your own sales summary.', 403);
    }
    if (callerType === 'Associate') {
      const [isMyTm] = await sql`
        SELECT 1 FROM team_members 
        WHERE user_id = ${targetTmId} AND associate_id = ${callerId} AND status IN ('approved', 'active')
        LIMIT 1
      `;
      if (!isMyTm) {
        return err(res, 'Access denied: This Team Member is not in your team.', 403);
      }
    }

    const [tmUser] = await sql`SELECT user_id, full_name, member_id FROM users WHERE user_id = ${targetTmId}`;
    if (!tmUser) return err(res, 'Team Member not found.', 404);

    // Aggregate queries on vw_sales_attribution
    const [kpis] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = FALSE)::INT AS plots_sold_count,
        COALESCE(SUM(sale_value) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = FALSE), 0)::NUMERIC AS total_sales_value,
        COUNT(*) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = TRUE)::INT AS own_purchases_count,
        COALESCE(SUM(sale_value) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = TRUE), 0)::NUMERIC AS own_purchases_value,
        COUNT(*) FILTER (WHERE booking_status IN ('Submitted', 'PaymentPending', 'Allocated') AND is_self_purchase = FALSE)::INT AS pending_bookings_count,
        COUNT(*) FILTER (WHERE associate_approval_status = 'Pending' AND is_self_purchase = FALSE)::INT AS pending_approval_count,
        COUNT(*) FILTER (WHERE is_reward_eligible = TRUE)::INT AS reward_eligible_count
      FROM vw_sales_attribution
      WHERE sold_by_user_id = ${targetTmId}
    `;

    // Direct customer referrals count
    const [custCount] = await sql`
      SELECT COUNT(*)::INT AS total_customers_referred
      FROM users
      WHERE referred_by_user_id = ${targetTmId} AND user_type = 'Customer'
    `;

    return ok(res, {
      team_member: tmUser,
      kpis: {
        plots_sold: Number(kpis?.plots_sold_count || 0),
        total_sales_value: Number(kpis?.total_sales_value || 0),
        own_purchases_count: Number(kpis?.own_purchases_count || 0),
        own_purchases_value: Number(kpis?.own_purchases_value || 0),
        pending_bookings_count: Number(kpis?.pending_bookings_count || 0),
        pending_approval_count: Number(kpis?.pending_approval_count || 0),
        reward_eligible_count: Number(kpis?.reward_eligible_count || 0),
        total_customers_referred: Number(custCount?.total_customers_referred || 0)
      }
    });
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * 2. GET /api/team-members/:id/customers-sales
 * Customer-wise aggregation of sales and bookings for a specific Team Member
 * Supports search, date range, pagination
 */
router.get('/team-members/:id/customers-sales', verifyUserToken, async (req, res) => {
  try {
    const targetTmId = Number(req.params.id);
    const [caller] = await sql`SELECT user_id, user_type, account_status FROM users WHERE user_id = ${req.user.user_id}`;
    if (!caller || !['Active', 'Approved'].includes(caller.account_status)) {
      return err(res, 'Access denied: Active account required.', 403);
    }
    const callerId = caller.user_id;
    const effectivePanel = resolveEffectivePanel(req.user);
    const callerType = effectivePanel === 'team-member' ? 'Team Member' : caller.user_type;

    if (callerType === 'Team Member' && callerId !== targetTmId) {
      return err(res, 'Access denied: You can only view your own customer sales.', 403);
    }
    if (callerType === 'Associate') {
      const [isMyTm] = await sql`
        SELECT 1 FROM team_members 
        WHERE user_id = ${targetTmId} AND associate_id = ${callerId} AND status IN ('approved', 'active')
        LIMIT 1
      `;
      if (!isMyTm) return err(res, 'Access denied: This Team Member is not in your team.', 403);
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const offset = (page - 1) * limit;
    const search = req.query.search ? String(req.query.search).trim() : '';
    const startDate = req.query.start_date || null;
    const endDate = req.query.end_date || null;

    const conditions = [
      sql`v.sold_by_user_id = ${targetTmId}`,
      sql`v.is_self_purchase = FALSE`
    ];
    if (search) {
      conditions.push(sql`(u.full_name ILIKE ${'%' + search + '%'} OR u.member_id ILIKE ${'%' + search + '%'} OR u.mobile_no ILIKE ${'%' + search + '%'})`);
    }
    if (startDate) {
      conditions.push(sql`v.booking_date >= ${startDate}`);
    }
    if (endDate) {
      conditions.push(sql`v.booking_date <= ${endDate}`);
    }

    const whereClause = conditions.reduce((acc, curr) => sql`${acc} AND ${curr}`);

    const customers = await sql`
      SELECT
        u.user_id AS customer_id,
        u.full_name AS customer_name,
        u.member_id AS customer_member_id,
        u.mobile_no AS customer_mobile,
        COUNT(v.booking_id)::INT AS plots_bought_count,
        COALESCE(SUM(v.sale_value), 0)::NUMERIC AS total_sales_value,
        MAX(v.booking_date) AS last_booking_date,
        json_agg(
          json_build_object(
            'booking_id', v.booking_id,
            'booking_serial', v.booking_serial,
            'plot_number', v.plot_number,
            'site_name', v.site_name,
            'sale_value', v.sale_value,
            'booking_status', v.booking_status,
            'payment_type', v.payment_type,
            'booking_date', v.booking_date,
            'confirmed_at', v.confirmed_at
          ) ORDER BY v.booking_date DESC
        ) AS bookings
      FROM users u
      JOIN vw_sales_attribution v ON v.buyer_user_id = u.user_id
      WHERE ${whereClause}
      GROUP BY u.user_id, u.full_name, u.member_id, u.mobile_no
      ORDER BY total_sales_value DESC, last_booking_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [totalRow] = await sql`
      SELECT COUNT(DISTINCT u.user_id)::INT AS total
      FROM users u
      JOIN vw_sales_attribution v ON v.buyer_user_id = u.user_id
      WHERE ${whereClause}
    `;

    return ok(res, customers, 'Customer sales retrieved successfully.', {
      pagination: {
        page,
        limit,
        total: Number(totalRow?.total || 0),
        pages: Math.ceil(Number(totalRow?.total || 0) / limit)
      }
    });
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * 3. GET /api/associates/:id/team-sales
 * Team-wide sales overview: team totals, direct sales, and member-wise breakdown
 */
const handleAssociateTeamSales = async (req, res, forceCsv = false) => {
  try {
    const targetAssocId = Number(req.params.id);
    const [caller] = await sql`SELECT user_id, user_type, account_status FROM users WHERE user_id = ${req.user.user_id}`;
    if (!caller || !['Active', 'Approved'].includes(caller.account_status)) {
      return err(res, 'Access denied: Active account required.', 403);
    }
    const callerId = caller.user_id;
    const effectivePanel = resolveEffectivePanel(req.user);
    const callerType = effectivePanel === 'team-member' ? 'Team Member' : caller.user_type;

    // Security Guard: Associate can only view their own team; Admin can view all
    if (callerType === 'Associate' && callerId !== targetAssocId) {
      return err(res, 'Access denied: You can only view your own team sales.', 403);
    }
    if (callerType === 'Team Member') {
      return err(res, 'Access denied: Team Members cannot view team-wide associate sales.', 403);
    }

    const [assocUser] = await sql`SELECT user_id, full_name, member_id FROM users WHERE user_id = ${targetAssocId}`;
    if (!assocUser) return err(res, 'Associate not found.', 404);

    // 1. Team Total Overview
    const [teamTotals] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = FALSE)::INT AS total_plots_sold,
        COALESCE(SUM(sale_value) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = FALSE), 0)::NUMERIC AS total_sales_value,
        COUNT(*) FILTER (WHERE is_confirmed_sale = TRUE AND sold_by_user_id = ${targetAssocId} AND is_self_purchase = FALSE)::INT AS direct_plots_sold,
        COALESCE(SUM(sale_value) FILTER (WHERE is_confirmed_sale = TRUE AND sold_by_user_id = ${targetAssocId} AND is_self_purchase = FALSE), 0)::NUMERIC AS direct_sales_value,
        COUNT(*) FILTER (WHERE is_confirmed_sale = TRUE AND booked_by_user_id = ${targetAssocId})::INT AS booked_by_me_count,
        COUNT(*) FILTER (WHERE associate_approval_status = 'Pending')::INT AS pending_approval_count
      FROM vw_sales_attribution
      WHERE associate_user_id = ${targetAssocId}
    `;

    // 2. Member-wise breakdown (Active team members under this associate)
    const membersBreakdown = await sql`
      SELECT 
        u.user_id AS team_member_id,
        u.full_name AS team_member_name,
        u.member_id AS team_member_uid,
        tm.slot_number,
        COALESCE(sales.plots_sold, 0)::INT AS plots_sold,
        COALESCE(sales.total_value, 0)::NUMERIC AS total_value,
        COALESCE(sales.pending_count, 0)::INT AS pending_count
      FROM team_members tm
      JOIN users u ON u.user_id = tm.user_id
      LEFT JOIN LATERAL (
        SELECT 
          COUNT(*) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = FALSE) AS plots_sold,
          SUM(sale_value) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = FALSE) AS total_value,
          COUNT(*) FILTER (WHERE booking_status IN ('Submitted', 'PaymentPending', 'Allocated') AND is_self_purchase = FALSE) AS pending_count
        FROM vw_sales_attribution
        WHERE sold_by_user_id = u.user_id
      ) sales ON TRUE
      WHERE tm.associate_id = ${targetAssocId} AND tm.status IN ('approved', 'active')
      ORDER BY tm.slot_number ASC, plots_sold DESC
    `;

    const isCsv = forceCsv || req.query?.format === 'csv' || req.path?.endsWith('/export') || req.headers.accept?.includes('text/csv');
    if (isCsv) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="associate_${targetAssocId}_team_sales.csv"`);
      let csv = 'Slot Number,Team Member ID,Member Code,Full Name,Plots Sold,Total Value (INR),Pending Bookings\n';
      for (const m of membersBreakdown) {
        csv += [
          m.slot_number,
          m.team_member_id,
          escapeCsvCell(m.member_id || m.team_member_uid),
          escapeCsvCell(m.team_member_name),
          m.plots_sold,
          m.total_value,
          m.pending_count
        ].join(',') + '\n';
      }
      return res.status(200).send(csv);
    }

    return ok(res, {
      associate: assocUser,
      team_totals: {
        total_plots_sold: Number(teamTotals?.total_plots_sold || 0),
        total_sales_value: Number(teamTotals?.total_sales_value || 0),
        direct_plots_sold: Number(teamTotals?.direct_plots_sold || 0),
        direct_sales_value: Number(teamTotals?.direct_sales_value || 0),
        booked_by_me_count: Number(teamTotals?.booked_by_me_count || 0),
        pending_approval_count: Number(teamTotals?.pending_approval_count || 0)
      },
      team_members: membersBreakdown
    });
  } catch (e) {
    return err(res, e.message);
  }
};

router.get('/associates/:id/team-sales', verifyUserToken, (req, res) => handleAssociateTeamSales(req, res, false));

/**
 * 4. GET /api/associates/:id/team-sales/export
 * CSV export of associate team sales
 */
router.get('/associates/:id/team-sales/export', verifyUserToken, (req, res) => handleAssociateTeamSales(req, res, true));

/**
 * Unified Admin Leaderboards Handler
 * Handles both GET /api/admin/leaderboards and GET /api/admin/leaderboards/export
 * Query params: type ('team-members' | 'associates'), period ('all' | 'month' | 'quarter' | 'year')
 */
async function handleLeaderboards(req, res, isExport = false) {
  try {
    const type = req.query.type === 'associates' ? 'associates' : 'team-members';
    const period = String(req.query.period || 'all').toLowerCase();
    const { start_date, end_date, site_id, payment_type, associate_id, limit = 100, page = 1 } = req.query;

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(200, Math.max(1, Number(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [
      sql`b.is_confirmed_sale = TRUE`,
      sql`b.is_self_purchase = FALSE`
    ];

    if (type === 'associates') {
      conditions.push(sql`b.associate_user_id IS NOT NULL`);
    } else {
      conditions.push(sql`b.sold_by_user_type = 'Team Member'`);
      if (associate_id) {
        conditions.push(sql`b.associate_user_id = ${Number(associate_id)}`);
      }
    }

    if (period === 'month') {
      conditions.push(sql`COALESCE(b.confirmed_at, b.booking_date) >= DATE_TRUNC('month', CURRENT_TIMESTAMP)`);
    } else if (period === 'quarter') {
      conditions.push(sql`COALESCE(b.confirmed_at, b.booking_date) >= DATE_TRUNC('quarter', CURRENT_TIMESTAMP)`);
    } else if (period === 'year') {
      conditions.push(sql`COALESCE(b.confirmed_at, b.booking_date) >= DATE_TRUNC('year', CURRENT_TIMESTAMP)`);
    }

    if (start_date) conditions.push(sql`COALESCE(b.confirmed_at, b.booking_date) >= ${start_date}`);
    if (end_date) conditions.push(sql`COALESCE(b.confirmed_at, b.booking_date) <= ${end_date}`);
    if (site_id) conditions.push(sql`b.site_id = ${Number(site_id)}`);
    if (payment_type) conditions.push(sql`b.payment_type = ${payment_type}`);

    const whereSql = conditions.reduce((acc, curr) => sql`${acc} AND ${curr}`);

    let rows = [];
    if (type === 'associates') {
      rows = await sql`
        SELECT
          b.associate_user_id AS user_id,
          COALESCE(b.associate_name, 'Unknown Associate') AS full_name,
          COALESCE(b.associate_member_id, '') AS member_id,
          b.associate_mobile AS mobile_no,
          COALESCE(SUM(b.plot_area), 0)::NUMERIC AS total_gaj_sold,
          COUNT(*)::INT AS plots_sold_count,
          COALESCE(SUM(b.sale_value), 0)::NUMERIC AS total_sales_value,
          MIN(COALESCE(b.confirmed_at, b.booking_date)) AS earliest_confirmed_sale,
          DENSE_RANK() OVER (ORDER BY COUNT(*) DESC, SUM(b.sale_value) DESC, MIN(COALESCE(b.confirmed_at, b.booking_date)) ASC)::INT AS rank
        FROM vw_sales_attribution b
        WHERE ${whereSql}
        GROUP BY b.associate_user_id, b.associate_name, b.associate_member_id, b.associate_mobile
        ORDER BY rank ASC
        ${isExport ? sql`` : sql`LIMIT ${limitNum} OFFSET ${offset}`}
      `;
    } else {
      rows = await sql`
        SELECT
          b.sold_by_user_id AS user_id,
          COALESCE(b.sold_by_name, 'Unknown Team Member') AS full_name,
          COALESCE(b.sold_by_member_id, '') AS member_id,
          b.sold_by_mobile AS mobile_no,
          b.associate_user_id,
          b.associate_name,
          COALESCE(SUM(b.plot_area), 0)::NUMERIC AS total_gaj_sold,
          COUNT(*)::INT AS plots_sold_count,
          COALESCE(SUM(b.sale_value), 0)::NUMERIC AS total_sales_value,
          MIN(COALESCE(b.confirmed_at, b.booking_date)) AS earliest_confirmed_sale,
          DENSE_RANK() OVER (ORDER BY COUNT(*) DESC, SUM(b.sale_value) DESC, MIN(COALESCE(b.confirmed_at, b.booking_date)) ASC)::INT AS rank
        FROM vw_sales_attribution b
        WHERE ${whereSql}
        GROUP BY b.sold_by_user_id, b.sold_by_name, b.sold_by_member_id, b.sold_by_mobile, b.associate_user_id, b.associate_name
        ORDER BY rank ASC
        ${isExport ? sql`` : sql`LIMIT ${limitNum} OFFSET ${offset}`}
      `;
    }

    if (isExport) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="leaderboard_${type}_${period}.csv"`);
      let csv = 'Rank,Member Code,Full Name,Mobile,Total Gaj Sold,Plots Sold,Total Revenue (INR)\n';
      for (const r of rows) {
        csv += [
          r.rank,
          escapeCsvCell(r.member_id),
          escapeCsvCell(r.full_name),
          escapeCsvCell(r.mobile_no || ''),
          r.total_gaj_sold || 0,
          r.plots_sold_count || 0,
          r.total_sales_value || 0
        ].join(',') + '\n';
      }
      return res.status(200).send(csv);
    }

    const formattedRows = rows.map((r, idx) => ({
      rank: Number(r.rank || idx + 1),
      user_id: Number(r.user_id),
      full_name: r.full_name,
      member_id: r.member_id,
      mobile_no: r.mobile_no || '',
      total_gaj_sold: Number(r.total_gaj_sold || 0),
      plots_sold_count: Number(r.plots_sold_count || 0),
      total_sales_value: Number(r.total_sales_value || 0),
      associate_user_id: r.associate_user_id ? Number(r.associate_user_id) : undefined,
      associate_name: r.associate_name || undefined
    }));

    return ok(res, formattedRows, 'Leaderboard rankings retrieved successfully.');
  } catch (e) {
    return err(res, e.message);
  }
}

router.get('/admin/leaderboards', verifyAdminToken, role('SuperAdmin', 'FinanceManager', 'SiteManager'), (req, res) => handleLeaderboards(req, res, false));
router.get('/admin/leaderboards/export', verifyAdminToken, role('SuperAdmin', 'FinanceManager', 'SiteManager'), (req, res) => handleLeaderboards(req, res, true));
router.get('/admin/leaderboard', verifyAdminToken, role('SuperAdmin', 'FinanceManager', 'SiteManager'), (req, res) => handleLeaderboards(req, res, false));
router.get('/admin/leaderboard/export', verifyAdminToken, role('SuperAdmin', 'FinanceManager', 'SiteManager'), (req, res) => handleLeaderboards(req, res, true));

/**
 * 5. GET /api/admin/leaderboard/team-members
 * Team Members ranking: plots sold desc -> total value desc -> earliest confirmed sale asc
 * Excludes self-purchases and Company Direct!
 */
router.get('/admin/leaderboard/team-members', verifyAdminToken, role('SuperAdmin', 'FinanceManager', 'SiteManager'), async (req, res) => {
  try {
    const { start_date, end_date, site_id, payment_type, associate_id, limit = 50, page = 1 } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(200, Math.max(1, Number(limit)));
    const offset = (pageNum - 1) * limitNum;

    // Build parameterized conditions
    const conditions = [
      sql`b.is_confirmed_sale = TRUE`,
      sql`b.is_self_purchase = FALSE`,
      sql`b.sold_by_user_type = 'Team Member'`
    ];

    if (start_date) conditions.push(sql`b.confirmed_at >= ${start_date}`);
    if (end_date) conditions.push(sql`b.confirmed_at <= ${end_date}`);
    if (site_id) conditions.push(sql`b.site_id = ${Number(site_id)}`);
    if (payment_type) conditions.push(sql`b.payment_type = ${payment_type}`);
    if (associate_id) conditions.push(sql`b.associate_user_id = ${Number(associate_id)}`);

    const leaderboard = await sql`
      SELECT
        b.sold_by_user_id AS team_member_id,
        b.sold_by_name AS team_member_name,
        b.sold_by_member_id AS team_member_uid,
        b.associate_user_id,
        b.associate_name,
        COUNT(*)::INT AS plots_sold,
        SUM(b.sale_value)::NUMERIC AS total_sales_value,
        MIN(b.confirmed_at) AS earliest_confirmed_sale,
        DENSE_RANK() OVER (ORDER BY COUNT(*) DESC, SUM(b.sale_value) DESC, MIN(b.confirmed_at) ASC) AS rank
      FROM vw_sales_attribution b
      WHERE ${conditions.reduce((acc, curr) => sql`${acc} AND ${curr}`)}
      GROUP BY b.sold_by_user_id, b.sold_by_name, b.sold_by_member_id, b.associate_user_id, b.associate_name
      ORDER BY rank ASC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    return ok(res, leaderboard, 'Team Member leaderboard retrieved successfully.');
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * 6. GET /api/admin/leaderboard/team-members/export
 * CSV export of Team Member leaderboard with formula injection protection
 */
router.get('/admin/leaderboard/team-members/export', verifyAdminToken, role('SuperAdmin', 'FinanceManager', 'SiteManager'), async (req, res) => {
  try {
    const { start_date, end_date, site_id, payment_type, associate_id } = req.query;

    const conditions = [
      sql`b.is_confirmed_sale = TRUE`,
      sql`b.is_self_purchase = FALSE`,
      sql`b.sold_by_user_type = 'Team Member'`
    ];

    if (start_date) conditions.push(sql`b.confirmed_at >= ${start_date}`);
    if (end_date) conditions.push(sql`b.confirmed_at <= ${end_date}`);
    if (site_id) conditions.push(sql`b.site_id = ${Number(site_id)}`);
    if (payment_type) conditions.push(sql`b.payment_type = ${payment_type}`);
    if (associate_id) conditions.push(sql`b.associate_user_id = ${Number(associate_id)}`);

    const leaderboard = await sql`
      SELECT
        b.sold_by_user_id AS team_member_id,
        b.sold_by_name AS team_member_name,
        b.sold_by_member_id AS team_member_uid,
        b.associate_user_id,
        b.associate_name,
        COUNT(*)::INT AS plots_sold,
        SUM(b.sale_value)::NUMERIC AS total_sales_value,
        MIN(b.confirmed_at) AS earliest_confirmed_sale,
        DENSE_RANK() OVER (ORDER BY COUNT(*) DESC, SUM(b.sale_value) DESC, MIN(b.confirmed_at) ASC) AS rank
      FROM vw_sales_attribution b
      WHERE ${conditions.reduce((acc, curr) => sql`${acc} AND ${curr}`)}
      GROUP BY b.sold_by_user_id, b.sold_by_name, b.sold_by_member_id, b.associate_user_id, b.associate_name
      ORDER BY rank ASC
    `;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leaderboard_team_members.csv"');

    let csv = 'Rank,Team Member ID,Member Code,Full Name,Associate Leader,Plots Sold,Total Sales Value,Earliest Confirmed Sale\n';
    for (const r of leaderboard) {
      csv += [
        r.rank,
        r.team_member_id,
        escapeCsvCell(r.team_member_uid),
        escapeCsvCell(r.team_member_name),
        escapeCsvCell(r.associate_name),
        r.plots_sold,
        r.total_sales_value,
        escapeCsvCell(r.earliest_confirmed_sale || '')
      ].join(',') + '\n';
    }

    return res.status(200).send(csv);
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * 7. GET /api/admin/leaderboard/associates
 * Associate leaderboard: plots sold desc -> total value desc -> earliest confirmed sale asc
 */
router.get('/admin/leaderboard/associates', verifyAdminToken, role('SuperAdmin', 'FinanceManager', 'SiteManager'), async (req, res) => {
  try {
    const { start_date, end_date, site_id, payment_type, limit = 50, page = 1 } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(200, Math.max(1, Number(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [
      sql`b.is_confirmed_sale = TRUE`,
      sql`b.is_self_purchase = FALSE`,
      sql`b.associate_user_id IS NOT NULL`
    ];

    if (start_date) conditions.push(sql`b.confirmed_at >= ${start_date}`);
    if (end_date) conditions.push(sql`b.confirmed_at <= ${end_date}`);
    if (site_id) conditions.push(sql`b.site_id = ${Number(site_id)}`);
    if (payment_type) conditions.push(sql`b.payment_type = ${payment_type}`);

    const leaderboard = await sql`
      SELECT
        b.associate_user_id,
        b.associate_name,
        b.associate_member_id,
        COUNT(*)::INT AS total_plots_sold,
        SUM(b.sale_value)::NUMERIC AS total_sales_value,
        COUNT(*) FILTER (WHERE b.sold_by_user_id = b.associate_user_id)::INT AS direct_sales_count,
        COUNT(*) FILTER (WHERE b.sold_by_user_id <> b.associate_user_id)::INT AS team_sales_count,
        MIN(b.confirmed_at) AS earliest_confirmed_sale,
        DENSE_RANK() OVER (ORDER BY COUNT(*) DESC, SUM(b.sale_value) DESC, MIN(b.confirmed_at) ASC) AS rank
      FROM vw_sales_attribution b
      WHERE ${conditions.reduce((acc, curr) => sql`${acc} AND ${curr}`)}
      GROUP BY b.associate_user_id, b.associate_name, b.associate_member_id
      ORDER BY rank ASC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    return ok(res, leaderboard, 'Associate leaderboard retrieved successfully.');
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * 8. GET /api/admin/leaderboard/associates/export
 * CSV export of Associate leaderboard with formula injection protection
 */
router.get('/admin/leaderboard/associates/export', verifyAdminToken, role('SuperAdmin', 'FinanceManager', 'SiteManager'), async (req, res) => {
  try {
    const { start_date, end_date, site_id, payment_type } = req.query;

    const conditions = [
      sql`b.is_confirmed_sale = TRUE`,
      sql`b.is_self_purchase = FALSE`,
      sql`b.associate_user_id IS NOT NULL`
    ];

    if (start_date) conditions.push(sql`b.confirmed_at >= ${start_date}`);
    if (end_date) conditions.push(sql`b.confirmed_at <= ${end_date}`);
    if (site_id) conditions.push(sql`b.site_id = ${Number(site_id)}`);
    if (payment_type) conditions.push(sql`b.payment_type = ${payment_type}`);

    const leaderboard = await sql`
      SELECT
        b.associate_user_id,
        b.associate_name,
        b.associate_member_id,
        COUNT(*)::INT AS total_plots_sold,
        SUM(b.sale_value)::NUMERIC AS total_sales_value,
        COUNT(*) FILTER (WHERE b.sold_by_user_id = b.associate_user_id)::INT AS direct_sales_count,
        COUNT(*) FILTER (WHERE b.sold_by_user_id <> b.associate_user_id)::INT AS team_sales_count,
        MIN(b.confirmed_at) AS earliest_confirmed_sale,
        DENSE_RANK() OVER (ORDER BY COUNT(*) DESC, SUM(b.sale_value) DESC, MIN(b.confirmed_at) ASC) AS rank
      FROM vw_sales_attribution b
      WHERE ${conditions.reduce((acc, curr) => sql`${acc} AND ${curr}`)}
      GROUP BY b.associate_user_id, b.associate_name, b.associate_member_id
      ORDER BY rank ASC
    `;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leaderboard_associates.csv"');

    let csv = 'Rank,Associate ID,Member Code,Full Name,Total Plots Sold,Total Sales Value,Direct Sales,Team Sales,Earliest Confirmed Sale\n';
    for (const r of leaderboard) {
      csv += [
        r.rank,
        r.associate_user_id,
        escapeCsvCell(r.associate_member_id),
        escapeCsvCell(r.associate_name),
        r.total_plots_sold,
        r.total_sales_value,
        r.direct_sales_count,
        r.team_sales_count,
        escapeCsvCell(r.earliest_confirmed_sale || '')
      ].join(',') + '\n';
    }

    return res.status(200).send(csv);
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * 9. GET /api/admin/leaderboard/associates/:id/drilldown
 * Admin drill-down view into an associate's team breakdown
 */
router.get('/admin/leaderboard/associates/:id/drilldown', verifyAdminToken, role('SuperAdmin', 'FinanceManager', 'SiteManager'), async (req, res) => {
  try {
    const targetAssocId = Number(req.params.id);
    const [assocUser] = await sql`SELECT user_id, full_name, member_id FROM users WHERE user_id = ${targetAssocId}`;
    if (!assocUser) return err(res, 'Associate not found.', 404);

    const [teamTotals] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = FALSE)::INT AS total_plots_sold,
        COALESCE(SUM(sale_value) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = FALSE), 0)::NUMERIC AS total_sales_value,
        COUNT(*) FILTER (WHERE is_confirmed_sale = TRUE AND sold_by_user_id = ${targetAssocId} AND is_self_purchase = FALSE)::INT AS direct_plots_sold,
        COALESCE(SUM(sale_value) FILTER (WHERE is_confirmed_sale = TRUE AND sold_by_user_id = ${targetAssocId} AND is_self_purchase = FALSE), 0)::NUMERIC AS direct_sales_value,
        COUNT(*) FILTER (WHERE is_confirmed_sale = TRUE AND booked_by_user_id = ${targetAssocId})::INT AS booked_by_me_count,
        COUNT(*) FILTER (WHERE associate_approval_status = 'Pending')::INT AS pending_approval_count
      FROM vw_sales_attribution
      WHERE associate_user_id = ${targetAssocId}
    `;

    const membersBreakdown = await sql`
      SELECT 
        u.user_id AS team_member_id,
        u.full_name AS team_member_name,
        u.member_id AS team_member_uid,
        tm.slot_number,
        COALESCE(sales.plots_sold, 0)::INT AS plots_sold,
        COALESCE(sales.total_value, 0)::NUMERIC AS total_value,
        COALESCE(sales.pending_count, 0)::INT AS pending_count
      FROM team_members tm
      JOIN users u ON u.user_id = tm.user_id
      LEFT JOIN LATERAL (
        SELECT 
          COUNT(*) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = FALSE) AS plots_sold,
          SUM(sale_value) FILTER (WHERE is_confirmed_sale = TRUE AND is_self_purchase = FALSE) AS total_value,
          COUNT(*) FILTER (WHERE booking_status IN ('Submitted', 'PaymentPending', 'Allocated') AND is_self_purchase = FALSE) AS pending_count
        FROM vw_sales_attribution
        WHERE sold_by_user_id = u.user_id
      ) sales ON TRUE
      WHERE tm.associate_id = ${targetAssocId} AND tm.status IN ('approved', 'active')
      ORDER BY tm.slot_number ASC, plots_sold DESC
    `;

    return ok(res, {
      associate: assocUser,
      team_totals: {
        total_plots_sold: Number(teamTotals?.total_plots_sold || 0),
        total_sales_value: Number(teamTotals?.total_sales_value || 0),
        direct_plots_sold: Number(teamTotals?.direct_plots_sold || 0),
        direct_sales_value: Number(teamTotals?.direct_sales_value || 0),
        booked_by_me_count: Number(teamTotals?.booked_by_me_count || 0),
        pending_approval_count: Number(teamTotals?.pending_approval_count || 0)
      },
      team_members: membersBreakdown
    }, 'Associate drill-down retrieved successfully.');
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * 10. GET /api/admin/sales-attribution/export
 * CSV export of sales attribution data with formula injection escaping
 */
router.get('/admin/sales-attribution/export', verifyAdminToken, async (req, res) => {
  try {
    const rows = await sql`
      SELECT
        booking_id, booking_serial, booking_date, confirmed_at, booking_status,
        plot_number, site_name, plot_area, sale_value, payment_type, is_upfront, is_reward_eligible,
        buyer_name, buyer_member_id, booked_by_name, booked_by_member_id,
        sold_by_name, sold_by_member_id, sold_by_user_type,
        associate_name, associate_member_id, booking_type, associate_approval_status
      FROM vw_sales_attribution
      ORDER BY booking_date DESC, booking_id DESC
    `;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sales_attribution_export.csv"');

    const headers = [
      'Booking ID', 'Serial', 'Booking Date', 'Confirmed At', 'Status',
      'Plot Number', 'Site', 'Area (Sq Yd)', 'Sale Value', 'Payment Type', 'Upfront', 'Reward Eligible',
      'Buyer Name', 'Buyer Member ID', 'Booked By', 'Booker Member ID',
      'Sold By', 'Seller Member ID', 'Seller Role', 'Associate Leader', 'Associate Member ID',
      'Booking Type', 'Approval Status'
    ];
    let csv = headers.join(',') + '\n';

    for (const r of rows) {
      csv += [
        r.booking_id,
        escapeCsvCell(r.booking_serial),
        r.booking_date || '',
        r.confirmed_at || '',
        escapeCsvCell(r.booking_status),
        escapeCsvCell(r.plot_number || ''),
        escapeCsvCell(r.site_name || ''),
        r.plot_area || 0,
        r.sale_value || 0,
        escapeCsvCell(r.payment_type || ''),
        r.is_upfront ? 'Yes' : 'No',
        r.is_reward_eligible ? 'Yes' : 'No',
        escapeCsvCell(r.buyer_name || ''),
        escapeCsvCell(r.buyer_member_id || ''),
        escapeCsvCell(r.booked_by_name || ''),
        escapeCsvCell(r.booked_by_member_id || ''),
        escapeCsvCell(r.sold_by_name || ''),
        escapeCsvCell(r.sold_by_member_id || ''),
        escapeCsvCell(r.sold_by_user_type || ''),
        escapeCsvCell(r.associate_name || ''),
        escapeCsvCell(r.associate_member_id || ''),
        escapeCsvCell(r.booking_type || ''),
        escapeCsvCell(r.associate_approval_status || '')
      ].join(',') + '\n';
    }

    return res.status(200).send(csv);
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * 11. GET /api/admin/sales-attribution/unattributed
 * Ambiguous legacy customers vs explicit company direct customers
 * Supports search filter and returns aggregated booking volumes
 */
router.get('/admin/sales-attribution/unattributed', verifyAdminToken, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const offset = (page - 1) * limit;
    const search = req.query.search ? String(req.query.search).trim() : '';

    const { tab } = req.query;

    const conditions = [
      sql`u.user_type = 'Customer'`,
      sql`u.referred_by_user_id IS NULL`
    ];
    if (search) {
      conditions.push(sql`(u.full_name ILIKE ${'%' + search + '%'} OR u.member_id ILIKE ${'%' + search + '%'} OR u.mobile_no ILIKE ${'%' + search + '%'})`);
    }
    if (tab === 'COMPANY_DIRECT') {
      conditions.push(sql`u.referred_by_source = 'DIRECT_SIGNUP'`);
    } else if (tab === 'LEGACY_AMBIGUOUS') {
      conditions.push(sql`u.referred_by_source IS NULL`);
    }

    const whereClause = conditions.reduce((acc, curr) => sql`${acc} AND ${curr}`);

    const rows = await sql`
      SELECT 
        u.user_id,
        u.member_id,
        u.full_name,
        u.mobile_no,
        u.registered_at,
        u.sponsor_user_id,
        u.referred_by_source,
        CASE
          WHEN u.referred_by_source = 'DIRECT_SIGNUP' OR u.referred_by_source = 'ADMIN_ASSIGNED' THEN 'COMPANY_DIRECT'
          WHEN u.referred_by_source IS NULL AND (u.sponsor_user_id = 1 OR u.sponsor_user_id IS NULL) THEN 'LEGACY_AMBIGUOUS'
          ELSE 'COMPANY_DIRECT'
        END AS unattributed_type,
        (SELECT COUNT(*)::INT FROM bookings b WHERE b.user_id = u.user_id) AS total_bookings_count,
        COALESCE((SELECT SUM(b.advance_amount + b.remaining_balance) FROM bookings b WHERE b.user_id = u.user_id), 0)::NUMERIC AS total_sales_volume
      FROM users u
      WHERE ${whereClause}
      ORDER BY u.registered_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [stats] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE referred_by_source = 'DIRECT_SIGNUP')::INT AS direct_signup_count,
        COUNT(*) FILTER (WHERE referred_by_source IS NULL)::INT AS legacy_ambiguous_count,
        COUNT(*)::INT AS total_unattributed
      FROM users
      WHERE user_type = 'Customer' AND referred_by_user_id IS NULL
    `;

    return ok(res, {
      stats: {
        total_unattributed: Number(stats?.total_unattributed || 0),
        legacy_ambiguous_count: Number(stats?.legacy_ambiguous_count || 0),
        direct_signup_count: Number(stats?.direct_signup_count || 0)
      },
      customers: rows
    });
  } catch (e) {
    return err(res, e.message);
  }
});

export default router;
