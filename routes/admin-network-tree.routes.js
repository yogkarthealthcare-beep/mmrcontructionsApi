import express from 'express';
import sql from '../db.js';

const router = express.Router();

const ok = (res, data, message = 'Success', status = 200) =>
  res.status(status).json({ success: true, message, data });

const err = (res, message = 'Request failed', status = 400) =>
  res.status(status).json({ success: false, message });

/**
 * Escape ILIKE special wildcards (%, _, \)
 */
const escapeIlike = (str = '') => String(str).replace(/[%_\\]/g, '\\$&');

/**
 * Format database row with clean numeric casting
 */
const formatNode = (row) => ({
  user_id: row.user_id,
  member_id: row.member_id,
  full_name: row.full_name,
  user_type: row.user_type,
  account_status: row.account_status,
  sponsor_user_id: row.sponsor_user_id,
  sponsor_member_id: row.sponsor_member_id || null,
  sponsor_name: row.sponsor_name || null,
  mobile_no: row.mobile_no || null,
  email: row.email || null,
  registered_at: row.registered_at || null,
  level: Number(row.level || 0),
  profile_image_url: row.profile_image_url || '',
  slot_number: row.slot_number != null ? Number(row.slot_number) : null,
  sales_gaj: Number(row.sales_gaj || 0),
  commission_earned: Number(row.commission_earned || 0),
  children_count: Number(row.children_count || 0),
  downline_count: Number(row.downline_count || 0),
  total_purchased_plots: Number(row.total_purchased_plots || row.purchased_plots_count || 0),
  purchased_plots_count: Number(row.total_purchased_plots || row.purchased_plots_count || 0),
  total_purchased_amount: Number(row.total_purchased_amount || row.purchased_amount || 0),
  purchased_amount: Number(row.total_purchased_amount || row.purchased_amount || 0)
});

/**
 * Helper to fetch virtual Admin root details
 */
async function getAdminVirtualNode(adminUser, showCustomers = false) {
  const [counts] = await sql`
    SELECT
      COUNT(CASE WHEN u.sponsor_user_id IS NULL AND u.user_type::text = 'Associate' THEN 1 END)::int AS top_level_count,
      COUNT(CASE 
        WHEN (${showCustomers} = true AND u.user_type::text IN ('Associate', 'Team Member', 'Customer'))
          OR (${showCustomers} = false AND u.user_type::text IN ('Associate', 'Team Member'))
        THEN 1 END)::int AS total_network_count
    FROM users u
  `;

  return {
    user_id: 'ADMIN',
    member_id: 'MMR-0',
    full_name: 'MMR Admin',
    user_type: 'Admin',
    account_status: 'Active',
    sponsor_user_id: null,
    sponsor_member_id: null,
    sponsor_name: null,
    level: 0,
    children_count: Number(counts?.top_level_count || 0),
    downline_count: Number(counts?.total_network_count || 0),
    slot_number: null,
    sales_gaj: 0,
    commission_earned: 0,
    profile_image_url: '',
    mobile_no: null,
    email: adminUser?.email || 'admin@mmrconstructions.in',
    city: null,
    registered_at: null
  };
}

/**
 * 1. GET /api/admin/network-tree
 * Fetches root + descendants up to `depth` levels (clamped to 1..6, default 4).
 * Default root starts from the top associate (Suraj Kumar Verma / MMR00001) rather than a virtual Admin node.
 */
router.get('/', async (req, res) => {
  try {
    const rawRoot = String(req.query.root || 'ADMIN').trim();
    // Clamp depth strictly to 1..6
    const depth = Math.min(Math.max(1, parseInt(req.query.depth || '4', 10) || 4), 6);
    const showCustomers = String(req.query.show_customers || 'false').toLowerCase() === 'true';

    const isRootAdmin = rawRoot.toUpperCase() === 'ADMIN' || rawRoot === '0' || rawRoot === 'MMR-0' || !rawRoot;
    let rootUserId = !isRootAdmin ? parseInt(rawRoot, 10) : null;

    let targetRootId = rootUserId;

    if (isRootAdmin || !targetRootId || isNaN(targetRootId)) {
      // Find the primary top associate (e.g. Suraj Kumar Verma / MMR00001)
      const [topAssociate] = await sql`
        SELECT user_id, member_id, full_name, user_type::text AS user_type
        FROM users
        WHERE sponsor_user_id IS NULL AND user_type::text = 'Associate'
        ORDER BY user_id ASC
        LIMIT 1
      `;
      if (topAssociate) {
        targetRootId = topAssociate.user_id;
      } else {
        // Fallback to first associate in database
        const [firstAssoc] = await sql`
          SELECT user_id, member_id, full_name, user_type::text AS user_type
          FROM users
          WHERE user_type::text = 'Associate'
          ORDER BY user_id ASC
          LIMIT 1
        `;
        targetRootId = firstAssoc?.user_id || null;
      }
    }

    if (!targetRootId) {
      return ok(res, {
        root: null,
        depth,
        total_nodes: 0,
        nodes: []
      });
    }

    const rows = await sql`
      WITH RECURSIVE tree_cte AS (
        -- Level 0: The selected root user (Suraj Kumar Verma or specified associate)
        SELECT u.user_id, u.member_id, u.full_name, u.user_type::text AS user_type,
               u.account_status::text AS account_status, u.sponsor_user_id,
               u.mobile_no, u.email, u.registered_at,
               0 AS level,
               ARRAY[u.user_id] AS path,
               false AS is_cycle
        FROM users u
        WHERE u.user_id = ${targetRootId}

        UNION ALL

        -- Deeper levels (Level 1..depth)
        SELECT u.user_id, u.member_id, u.full_name, u.user_type::text AS user_type,
               u.account_status::text AS account_status, u.sponsor_user_id,
               u.mobile_no, u.email, u.registered_at,
               t.level + 1 AS level,
               t.path || u.user_id AS path,
               u.user_id = ANY(t.path) AS is_cycle
        FROM users u
        JOIN tree_cte t ON u.sponsor_user_id = t.user_id
        WHERE t.level < ${depth}
          AND NOT t.is_cycle
          AND (
            (${showCustomers} = true AND u.user_type::text IN ('Associate', 'Team Member', 'Customer'))
            OR (${showCustomers} = false AND u.user_type::text IN ('Associate', 'Team Member'))
          )
      )
      SELECT t.user_id, t.member_id, t.full_name, t.user_type, t.account_status,
             t.sponsor_user_id, t.mobile_no, t.email, t.registered_at, t.level,
             '' AS profile_image_url,
             tm.slot_number,
             sp.member_id AS sponsor_member_id, sp.full_name AS sponsor_name,
             COALESCE(pur.total_purchased_plots, 0)::int AS total_purchased_plots,
             COALESCE(pur.total_purchased_amount, 0)::numeric AS total_purchased_amount,
             COALESCE(ast.total_gaj_sold, 0)::numeric AS sales_gaj,
             COALESCE(ast.total_commission_earned, 0)::numeric AS commission_earned,
             COALESCE(pur.total_purchased_plots, 0)::int AS total_purchased_plots,
             COALESCE(pur.total_purchased_amount, 0)::numeric AS total_purchased_amount,
             COALESCE(pur.total_purchased_plots, 0)::int AS total_purchased_plots,
             COALESCE(pur.total_purchased_amount, 0)::numeric AS total_purchased_amount,
             (
               SELECT COUNT(*)::int FROM users c
               WHERE c.sponsor_user_id = t.user_id
                 AND (
                   (${showCustomers} = true AND c.user_type::text IN ('Associate', 'Team Member', 'Customer'))
                   OR (${showCustomers} = false AND c.user_type::text IN ('Associate', 'Team Member'))
                 )
             ) AS children_count,
             (
               WITH RECURSIVE downline_cte AS (
                 SELECT d.user_id, ARRAY[d.user_id] AS path, false AS is_cycle
                 FROM users d
                 WHERE d.sponsor_user_id = t.user_id
                   AND (
                     (${showCustomers} = true AND d.user_type::text IN ('Associate', 'Team Member', 'Customer'))
                     OR (${showCustomers} = false AND d.user_type::text IN ('Associate', 'Team Member'))
                   )
                 UNION ALL
                 SELECT gd.user_id, dc.path || gd.user_id, gd.user_id = ANY(dc.path)
                 FROM users gd
                 JOIN downline_cte dc ON gd.sponsor_user_id = dc.user_id
                 WHERE NOT dc.is_cycle AND array_length(dc.path, 1) < 20
                   AND (
                     (${showCustomers} = true AND gd.user_type::text IN ('Associate', 'Team Member', 'Customer'))
                     OR (${showCustomers} = false AND gd.user_type::text IN ('Associate', 'Team Member'))
                   )
               )
               SELECT COUNT(*)::int FROM downline_cte
             ) AS downline_count
      FROM tree_cte t
      LEFT JOIN team_members tm ON (tm.user_id = t.user_id OR tm.team_member_uid = t.member_id)
      LEFT JOIN users sp ON sp.user_id = t.sponsor_user_id
      LEFT JOIN associate_sales_tracker ast ON ast.associate_user_id = t.user_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(DISTINCT b.booking_id)::int AS total_purchased_plots,
          COALESCE(SUM(COALESCE(b.base_price, p.sold_price, p.base_price, (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0)), 0)::numeric AS total_purchased_amount
        FROM bookings b
        LEFT JOIN plots p ON p.plot_id = b.plot_id
        WHERE (b.user_id = t.user_id OR (tm.id IS NOT NULL AND b.user_id = tm.id))
          AND b.booking_status NOT IN ('Cancelled', 'Rejected', 'Draft')
      ) pur ON TRUE
      ORDER BY t.level, COALESCE(tm.slot_number, 999), t.registered_at ASC;
    `;

    if (rows.length === 0) {
      return err(res, 'Root user not found', 404);
    }

    const nodes = rows.map(formatNode);

    return ok(res, {
      root: targetRootId,
      depth,
      total_nodes: nodes.length,
      nodes
    });
  } catch (e) {
    console.error('[Admin Network Tree Error]:', e);
    return err(res, e.message || 'Failed to fetch network tree');
  }
});

/**
 * 2. GET /api/admin/network-tree/children
 * Direct children only for on-demand lazy expansion.
 */
router.get('/children', async (req, res) => {
  try {
    const rawParent = String(req.query.parent || '').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize || '100', 10) || 100), 200);
    const offset = (page - 1) * pageSize;
    const showCustomers = String(req.query.show_customers || 'false').toLowerCase() === 'true';

    const isParentAdmin = rawParent.toUpperCase() === 'ADMIN' || rawParent === '0' || rawParent === 'MMR-0' || !rawParent;
    let parentUserId = !isParentAdmin ? parseInt(rawParent, 10) : null;

    if (isParentAdmin || !parentUserId || isNaN(parentUserId)) {
      const [topAssociate] = await sql`
        SELECT user_id FROM users WHERE sponsor_user_id IS NULL AND user_type::text = 'Associate' ORDER BY user_id ASC LIMIT 1
      `;
      parentUserId = topAssociate?.user_id || null;
    }

    if (!parentUserId) {
      return ok(res, {
        parent: null,
        total: 0,
        page,
        pageSize,
        items: []
      });
    }

    const whereCondition = sql`u.sponsor_user_id = ${parentUserId} AND (
      (${showCustomers} = true AND u.user_type::text IN ('Associate', 'Team Member', 'Customer'))
      OR (${showCustomers} = false AND u.user_type::text IN ('Associate', 'Team Member'))
    )`;

    const [totalCountRow] = await sql`
      SELECT COUNT(*)::int AS count
      FROM users u
      WHERE ${whereCondition}
    `;

    const total = totalCountRow?.count || 0;

    const rows = await sql`
      SELECT u.user_id, u.member_id, u.full_name, u.user_type::text AS user_type,
             u.account_status::text AS account_status, u.sponsor_user_id,
             u.mobile_no, u.email, u.registered_at,
             '' AS profile_image_url,
             tm.slot_number,
             sp.member_id AS sponsor_member_id, sp.full_name AS sponsor_name,
             COALESCE(ast.total_gaj_sold, 0)::numeric AS sales_gaj,
             COALESCE(ast.total_commission_earned, 0)::numeric AS commission_earned,
             (
               SELECT COUNT(*)::int FROM users c
               WHERE c.sponsor_user_id = u.user_id
                 AND (
                   (${showCustomers} = true AND c.user_type::text IN ('Associate', 'Team Member', 'Customer'))
                   OR (${showCustomers} = false AND c.user_type::text IN ('Associate', 'Team Member'))
                 )
             ) AS children_count,
             (
               WITH RECURSIVE downline_cte AS (
                 SELECT d.user_id, ARRAY[d.user_id] AS path, false AS is_cycle
                 FROM users d
                 WHERE d.sponsor_user_id = u.user_id
                   AND (
                     (${showCustomers} = true AND d.user_type::text IN ('Associate', 'Team Member', 'Customer'))
                     OR (${showCustomers} = false AND d.user_type::text IN ('Associate', 'Team Member'))
                   )
                 UNION ALL
                 SELECT gd.user_id, dc.path || gd.user_id, gd.user_id = ANY(dc.path)
                 FROM users gd
                 JOIN downline_cte dc ON gd.sponsor_user_id = dc.user_id
                 WHERE NOT dc.is_cycle AND array_length(dc.path, 1) < 20
                   AND (
                     (${showCustomers} = true AND gd.user_type::text IN ('Associate', 'Team Member', 'Customer'))
                     OR (${showCustomers} = false AND gd.user_type::text IN ('Associate', 'Team Member'))
                   )
               )
               SELECT COUNT(*)::int FROM downline_cte
             ) AS downline_count
      FROM users u
      LEFT JOIN team_members tm ON (tm.user_id = u.user_id OR tm.team_member_uid = u.member_id)
      LEFT JOIN users sp ON sp.user_id = u.sponsor_user_id
      LEFT JOIN associate_sales_tracker ast ON ast.associate_user_id = u.user_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(DISTINCT b.booking_id)::int AS total_purchased_plots,
          COALESCE(SUM(COALESCE(b.base_price, p.sold_price, p.base_price, (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0)), 0)::numeric AS total_purchased_amount
        FROM bookings b
        LEFT JOIN plots p ON p.plot_id = b.plot_id
        WHERE (b.user_id = u.user_id OR (tm.id IS NOT NULL AND b.user_id = tm.id))
          AND b.booking_status NOT IN ('Cancelled', 'Rejected', 'Draft')
      ) pur ON TRUE
      WHERE ${whereCondition}
      ORDER BY COALESCE(tm.slot_number, 999), u.registered_at ASC
      LIMIT ${pageSize} OFFSET ${offset};
    `;

    return ok(res, {
      parent: isParentAdmin ? 'ADMIN' : parentUserId,
      total,
      page,
      pageSize,
      items: rows.map(formatNode)
    });
  } catch (e) {
    console.error('[Admin Network Tree Children Error]:', e);
    return err(res, e.message || 'Failed to fetch child nodes');
  }
});

/**
 * 3. GET /api/admin/network-tree/search
 * Server-side search by member_id, full_name, mobile_no, and sponsor member_id.
 * Requires minimum 2 characters. Escapes wildcards in search pattern. Fully parameterized.
 */
router.get('/search', async (req, res) => {
  try {
    const rawQ = String(req.query.q || '').trim();
    if (!rawQ || rawQ.length < 2) {
      return ok(res, []);
    }

    const escapedQ = escapeIlike(rawQ);
    const term = `%${escapedQ}%`;
    const limit = Math.min(Math.max(1, parseInt(req.query.limit || '20', 10) || 20), 50);

    const matches = await sql`
      SELECT u.user_id, u.member_id, u.full_name, u.user_type::text AS user_type,
             u.account_status::text AS account_status, u.sponsor_user_id,
             u.mobile_no, u.email, u.registered_at,
             tm.slot_number,
             sp.member_id AS sponsor_member_id, sp.full_name AS sponsor_name,
             (
               SELECT COUNT(*)::int FROM users c
               WHERE c.sponsor_user_id = u.user_id
                 AND c.user_type::text IN ('Associate', 'Team Member')
             ) AS children_count
      FROM users u
      LEFT JOIN team_members tm ON (tm.user_id = u.user_id OR tm.team_member_uid = u.member_id)
      LEFT JOIN users sp ON sp.user_id = u.sponsor_user_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(DISTINCT b.booking_id)::int AS total_purchased_plots,
          COALESCE(SUM(COALESCE(b.base_price, p.sold_price, p.base_price, (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0)), 0)::numeric AS total_purchased_amount
        FROM bookings b
        LEFT JOIN plots p ON p.plot_id = b.plot_id
        WHERE (b.user_id = u.user_id OR (tm.id IS NOT NULL AND b.user_id = tm.id))
          AND b.booking_status NOT IN ('Cancelled', 'Rejected', 'Draft')
      ) pur ON TRUE
      WHERE (
        u.member_id ILIKE ${term}
        OR u.full_name ILIKE ${term}
        OR u.mobile_no ILIKE ${term}
        OR sp.member_id ILIKE ${term}
      )
      AND u.user_type::text IN ('Associate', 'Team Member')
      ORDER BY 
        CASE WHEN u.member_id ILIKE ${rawQ} THEN 0
             WHEN u.member_id ILIKE ${term} THEN 1
             WHEN u.full_name ILIKE ${term} THEN 2
             ELSE 3
        END,
        u.registered_at ASC
      LIMIT ${limit};
    `;

    return ok(res, matches.map(formatNode));
  } catch (e) {
    console.error('[Admin Network Tree Search Error]:', e);
    return err(res, e.message || 'Failed to execute search');
  }
});

/**
 * 4. GET /api/admin/network-tree/path
 * Returns ancestor chain from Admin root down to the target user for breadcrumbs.
 */
router.get('/path', async (req, res) => {
  try {
    const rawUserId = req.query.user_id || req.query.id;
    if (!rawUserId) {
      return err(res, 'user_id is required', 400);
    }

    const isRawAdmin = String(rawUserId).toUpperCase() === 'ADMIN' || rawUserId === '0' || rawUserId === 'MMR-0';
    let userId = !isRawAdmin ? parseInt(rawUserId, 10) : null;

    if (isRawAdmin || !userId || isNaN(userId)) {
      const [topAssociate] = await sql`
        SELECT user_id, member_id, full_name, user_type::text AS user_type
        FROM users
        WHERE sponsor_user_id IS NULL AND user_type::text = 'Associate'
        ORDER BY user_id ASC
        LIMIT 1
      `;
      if (topAssociate) {
        return ok(res, [{
          user_id: topAssociate.user_id,
          member_id: topAssociate.member_id,
          full_name: topAssociate.full_name,
          user_type: topAssociate.user_type
        }]);
      }
      return ok(res, []);
    }

    const ancestors = await sql`
      WITH RECURSIVE ancestors AS (
        SELECT u.user_id, u.member_id, u.full_name, u.user_type::text AS user_type,
               u.sponsor_user_id, 1 AS depth, ARRAY[u.user_id] AS path, false AS is_cycle
        FROM users u
        WHERE u.user_id = ${userId}

        UNION ALL

        SELECT p.user_id, p.member_id, p.full_name, p.user_type::text AS user_type,
               p.sponsor_user_id, a.depth + 1, a.path || p.user_id, p.user_id = ANY(a.path)
        FROM users p
        JOIN ancestors a ON p.user_id = a.sponsor_user_id
        WHERE NOT a.is_cycle AND a.depth < 20
      )
      SELECT user_id, member_id, full_name, user_type, sponsor_user_id, depth
      FROM ancestors
      ORDER BY depth DESC;
    `;

    if (ancestors.length === 0) {
      return err(res, 'User not found', 404);
    }

    const breadcrumbs = ancestors.map(a => ({
      user_id: a.user_id,
      member_id: a.member_id,
      full_name: a.full_name,
      user_type: a.user_type
    }));

    return ok(res, breadcrumbs);
  } catch (e) {
    console.error('[Admin Network Tree Path Error]:', e);
    return err(res, e.message || 'Failed to get ancestor path');
  }
});

export default router;
