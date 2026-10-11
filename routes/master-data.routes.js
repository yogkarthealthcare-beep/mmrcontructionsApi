import express from "express";
import jwt from "jsonwebtoken";
import sql from "../db.js";

const router = express.Router();

const ok = (res, data, msg = "Success", status = 200) =>
  res.status(status).json({ success: true, message: msg, data });

const err = (res, msg = "Server error", status = 500) =>
  res.status(status).json({ success: false, message: msg });

// Admin Authentication Middleware
const authAdmin = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return err(res, "No admin token provided", 401);
  try {
    req.admin = jwt.verify(auth.split(" ")[1], process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET);
    return next();
  } catch {
    return err(res, "Invalid or expired admin token", 401);
  }
};

const requireAdminRole = (req, res, next) => {
  const role = req.admin?.role || req.admin?.user_type || "Admin";
  if (!["SuperAdmin", "Admin"].includes(role)) {
    return err(res, "Only Admin/SuperAdmin can access Master Data Management.", 403);
  }
  return next();
};

// Safe table name validator
const isValidTableName = (name) => {
  return typeof name === "string" && /^[a-zA-Z0-9_]{1,63}$/.test(name);
};

// Helper to categorize tables for intuitive UI tabs
const getTableCategory = (tableName) => {
  const t = tableName.toLowerCase();
  if (["users", "user_wallets", "associate_referral_links", "referral_registrations", "admin_users"].includes(t)) {
    return "Users & Auth";
  }
  if (t.includes("associate") || t.includes("team_member") || t.includes("mlm") || t.includes("rank") || t.includes("commission")) {
    return "Associates & Network";
  }
  if (t.includes("investor")) {
    return "Investors";
  }
  if (t.includes("booking") || t.includes("customer") || t.includes("receipt") || t.includes("invoice") || t.includes("emi") || t.includes("order")) {
    return "Customers & Bookings";
  }
  if (t.includes("plot") || t.includes("site")) {
    return "Properties & Sites";
  }
  if (t.includes("payment") || t.includes("gateway") || t.includes("wallet") || t.includes("withdrawal")) {
    return "Finance & Payments";
  }
  return "System & Master";
};

/**
 * GET /api/admin/master-data/tables
 * Lists all public database tables with row counts and column counts
 */
router.get("/admin/master-data/tables", authAdmin, requireAdminRole, async (_req, res) => {
  try {
    const rawTables = await sql`
      SELECT 
        t.table_name,
        COALESCE(s.n_live_tup, 0) AS estimated_row_count,
        (
          SELECT COUNT(*) 
          FROM information_schema.columns c 
          WHERE c.table_schema = 'public' AND c.table_name = t.table_name
        ) AS column_count
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name
      WHERE t.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND t.table_name NOT LIKE 'knex_migrations%'
      ORDER BY t.table_name ASC
    `;

    const tables = rawTables.map((r) => ({
      tableName: r.table_name,
      rowCount: Number(r.estimated_row_count || 0),
      columnCount: Number(r.column_count || 0),
      category: getTableCategory(r.table_name)
    }));

    // Extract unique categories
    const categories = Array.from(new Set(tables.map((t) => t.category)));

    return ok(res, { tables, categories }, "Master tables fetched successfully");
  } catch (error) {
    console.error("[MasterData] Error fetching tables:", error);
    return err(res, "Failed to load database tables: " + error.message);
  }
});

/**
 * GET /api/admin/master-data/tables/:tableName
 * Fetches schema definition and paginated records for a selected table
 */
router.get("/admin/master-data/tables/:tableName", authAdmin, requireAdminRole, async (req, res) => {
  const { tableName } = req.params;
  if (!isValidTableName(tableName)) {
    return err(res, "Invalid table name specified", 400);
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(5, parseInt(req.query.limit) || 25));
  const offset = (page - 1) * limit;
  const search = req.query.search ? String(req.query.search).trim() : "";
  const sortBy = req.query.sortBy ? String(req.query.sortBy).trim() : null;
  const sortOrder = String(req.query.sortOrder || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";

  try {
    // 1. Check if table exists in public schema
    const [tableExists] = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = ${tableName}
      LIMIT 1
    `;
    if (!tableExists) {
      return err(res, `Table "${tableName}" does not exist`, 404);
    }

    // 2. Fetch columns definition
    const columns = await sql`
      SELECT 
        c.column_name, 
        c.data_type, 
        c.is_nullable, 
        c.column_default,
        c.character_maximum_length,
        CASE WHEN kcu.column_name IS NOT NULL THEN TRUE ELSE FALSE END AS is_primary_key
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT k.column_name, k.table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage k
          ON tc.constraint_name = k.constraint_name AND tc.table_schema = k.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
      ) kcu ON kcu.table_name = c.table_name AND kcu.column_name = c.column_name
      WHERE c.table_schema = 'public' AND c.table_name = ${tableName}
      ORDER BY c.ordinal_position ASC
    `;

    const primaryKeyCol = columns.find((c) => c.is_primary_key)?.column_name || columns[0]?.column_name || "id";

    // 3. Prepare search filter across columns if provided
    let whereClause = "";
    const searchParams = [];
    if (search) {
      const textColumns = columns
        .filter((c) => ["character varying", "text", "character", "integer", "bigint"].includes(c.data_type))
        .map((c) => `CAST("${c.column_name}" AS TEXT) ILIKE $1`);

      if (textColumns.length > 0) {
        whereClause = `WHERE (${textColumns.join(" OR ")})`;
        searchParams.push(`%${search}%`);
      }
    }

    // 4. Determine sorting column
    let orderColumn = primaryKeyCol;
    if (sortBy && columns.some((c) => c.column_name === sortBy)) {
      orderColumn = sortBy;
    }

    // 5. Query total count
    const countQuery = `SELECT COUNT(*) AS total FROM "${tableName}" ${whereClause}`;
    const [countRes] = await sql.unsafe(countQuery, searchParams);
    const total = parseInt(countRes?.total || 0, 10);

    // 6. Query records
    const recordsQuery = `
      SELECT * 
      FROM "${tableName}" 
      ${whereClause} 
      ORDER BY "${orderColumn}" ${sortOrder} 
      LIMIT ${limit} OFFSET ${offset}
    `;
    const records = await sql.unsafe(recordsQuery, searchParams);

    const totalPages = Math.ceil(total / limit) || 1;

    return ok(res, {
      tableName,
      primaryKey: primaryKeyCol,
      columns: columns.map((c) => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === "YES",
        isPk: c.is_primary_key,
        default: c.column_default
      })),
      records,
      pagination: {
        total,
        page,
        limit,
        totalPages
      }
    });
  } catch (error) {
    console.error(`[MasterData] Error querying table ${tableName}:`, error);
    return err(res, `Failed to load records for table ${tableName}: ` + error.message);
  }
});

/**
 * PUT /api/admin/master-data/tables/:tableName/:id
 * Modifies an existing row in the selected table
 */
router.put("/admin/master-data/tables/:tableName/:id", authAdmin, requireAdminRole, async (req, res) => {
  const { tableName, id } = req.params;
  const updateData = req.body?.data || req.body;

  if (!isValidTableName(tableName)) {
    return err(res, "Invalid table name", 400);
  }
  if (!id) {
    return err(res, "Primary key id required", 400);
  }
  if (!updateData || typeof updateData !== "object" || Object.keys(updateData).length === 0) {
    return err(res, "No update data provided", 400);
  }

  try {
    // 1. Get primary key column
    const [pkRes] = await sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ${tableName}
      ORDER BY kcu.ordinal_position ASC
      LIMIT 1
    `;
    const primaryKey = pkRes?.column_name || "id";

    // 2. Fetch all valid columns for this table
    const columns = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = ${tableName}
    `;
    const validColMap = new Map(columns.map((c) => [c.column_name, c.data_type]));

    // 3. Build parameterized UPDATE
    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, rawVal] of Object.entries(updateData)) {
      if (key === primaryKey) continue; // Do not mutate primary key
      if (!validColMap.has(key)) continue; // Ignore non-existent columns

      let val = rawVal;
      // Convert empty strings to null for nullable integer/numeric/date columns
      const type = validColMap.get(key);
      if (val === "" && (type.includes("int") || type.includes("numeric") || type.includes("timestamp") || type.includes("date") || type.includes("bool"))) {
        val = null;
      }

      setClauses.push(`"${key}" = $${paramIndex}`);
      values.push(val);
      paramIndex++;
    }

    if (setClauses.length === 0) {
      return err(res, "No valid columns to update", 400);
    }

    // Add updated_at if column exists and not already provided
    if (validColMap.has("updated_at") && !updateData.updated_at) {
      setClauses.push(`"updated_at" = NOW()`);
    }

    values.push(id);
    const updateSql = `
      UPDATE "${tableName}"
      SET ${setClauses.join(", ")}
      WHERE "${primaryKey}" = $${paramIndex}
      RETURNING *
    `;

    const [updatedRow] = await sql.unsafe(updateSql, values);
    if (!updatedRow) {
      return err(res, `Record with ${primaryKey}=${id} not found in ${tableName}`, 404);
    }

    return ok(res, updatedRow, `Record #${id} in table "${tableName}" updated successfully`);
  } catch (error) {
    console.error(`[MasterData] Error updating ${tableName} row ${id}:`, error);
    return err(res, `Failed to update record: ` + error.message);
  }
});

/**
 * DELETE /api/admin/master-data/tables/:tableName/:id
 * Deletes a row from the selected table
 */
router.delete("/admin/master-data/tables/:tableName/:id", authAdmin, requireAdminRole, async (req, res) => {
  const { tableName, id } = req.params;

  if (!isValidTableName(tableName)) {
    return err(res, "Invalid table name", 400);
  }
  if (!id) {
    return err(res, "Record ID is required", 400);
  }

  try {
    // 1. Get primary key column
    const [pkRes] = await sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ${tableName}
      ORDER BY kcu.ordinal_position ASC
      LIMIT 1
    `;
    const primaryKey = pkRes?.column_name || "id";

    // 2. Perform deletion
    const deleteSql = `DELETE FROM "${tableName}" WHERE "${primaryKey}" = $1 RETURNING *`;
    const [deletedRow] = await sql.unsafe(deleteSql, [id]);

    if (!deletedRow) {
      return err(res, `Record with ${primaryKey}=${id} not found in ${tableName}`, 404);
    }

    return ok(res, deletedRow, `Record #${id} successfully deleted from table "${tableName}"`);
  } catch (error) {
    console.error(`[MasterData] Error deleting from ${tableName} row ${id}:`, error);
    // If foreign key constraint blocks deletion, give clear helpful message
    if (error.code === "23503") {
      return err(res, `Cannot delete record: It is referenced by other records in related tables (${error.detail || error.message})`, 409);
    }
    return err(res, `Failed to delete record: ` + error.message);
  }
});

export default router;
