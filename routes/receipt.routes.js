import express from "express";
import sql from "../db.js";
import { adminAuth, userAuth } from "../middleware/auth.middleware.js";
import PDFDocument from "pdfkit";

const router = express.Router();

function ok(res, data = null, message = "Success", extra = {}) {
  return res.json({ success: true, message, data, ...extra });
}

function fail(res, message = "Failed", code = 400) {
  return res.status(code).json({ success: false, message });
}

// ── Auto-create Table if missing ─────────────────────────────
export async function ensureReceiptsTable() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS receipts (
        id BIGSERIAL PRIMARY KEY,
        receipt_no VARCHAR(100) UNIQUE NOT NULL,
        serial_no INTEGER NOT NULL DEFAULT 1,
        plot_no VARCHAR(100),
        plot_area VARCHAR(100),
        customer_id BIGINT,
        customer_name VARCHAR(255) NOT NULL,
        mobile_no VARCHAR(25) NOT NULL,
        r_o_p VARCHAR(255),
        payment_type VARCHAR(50) NOT NULL DEFAULT 'Cash',
        payment_mode VARCHAR(100) NOT NULL DEFAULT 'Full Payment',
        cheque_no VARCHAR(100),
        cheque_date DATE,
        bank_name VARCHAR(255),
        receipt_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
        paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
        inward_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
        amount_depositor_name VARCHAR(255),
        advisor_name VARCHAR(255),
        advisor_mobile VARCHAR(25),
        full_payment_time TIMESTAMPTZ,
        receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
        plotting_place VARCHAR(255) NOT NULL DEFAULT '00, TRIBHUVAN KHEDA, SHESHPUR, Unnao, Uttar Pradesh - 209801, India',
        depositor_signature TEXT,
        authorized_signature TEXT,
        notes TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'Active',
        is_locked BOOLEAN NOT NULL DEFAULT TRUE,
        created_by BIGINT,
        updated_by BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_receipts_receipt_no ON receipts(receipt_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_serial_no ON receipts(serial_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_customer_name ON receipts(customer_name);
      CREATE INDEX IF NOT EXISTS idx_receipts_mobile_no ON receipts(mobile_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_plot_no ON receipts(plot_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_receipt_date ON receipts(receipt_date);
      CREATE INDEX IF NOT EXISTS idx_receipts_customer_id ON receipts(customer_id);
      CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
      CREATE INDEX IF NOT EXISTS idx_receipts_created_at ON receipts(created_at DESC);
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS receipt_audit_log (
        id BIGSERIAL PRIMARY KEY,
        receipt_id BIGINT NOT NULL,
        receipt_no VARCHAR(100) NOT NULL,
        action VARCHAR(50) NOT NULL,
        performed_by BIGINT,
        performed_by_name VARCHAR(255),
        details JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_receipt_audit_receipt_id ON receipt_audit_log(receipt_id);
      CREATE INDEX IF NOT EXISTS idx_receipt_audit_receipt_no ON receipt_audit_log(receipt_no);
    `;
    console.log("[Receipts] PostgreSQL tables verified.");
  } catch (err) {
    console.error("[Receipts] Error verifying tables:", err);
  }
}

// Number to Words Converter (Indian Currency Format)
function numberToWords(num) {
  const n = Math.floor(Number(num) || 0);
  if (n === 0) return "Zero Rupees Only";

  const a = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"
  ];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function convertTwoDigits(v) {
    if (v < 20) return a[v];
    return b[Math.floor(v / 10)] + (v % 10 !== 0 ? " " + a[v % 10] : "");
  }

  function convertThreeDigits(v) {
    let str = "";
    if (v >= 100) {
      str += a[Math.floor(v / 100)] + " Hundred ";
      v %= 100;
    }
    if (v > 0) {
      str += convertTwoDigits(v);
    }
    return str.trim();
  }

  let words = "";
  let crore = Math.floor(n / 10000000);
  let rem = n % 10000000;
  let lakh = Math.floor(rem / 100000);
  rem %= 100000;
  let thousand = Math.floor(rem / 1000);
  rem %= 1000;
  let hundred = rem;

  if (crore > 0) words += convertThreeDigits(crore) + " Crore ";
  if (lakh > 0) words += convertThreeDigits(lakh) + " Lakh ";
  if (thousand > 0) words += convertThreeDigits(thousand) + " Thousand ";
  if (hundred > 0) words += convertThreeDigits(hundred) + " ";

  return (words.trim() + " Rupees Only").replace(/\s+/g, " ");
}

// ─────────────────────────────────────────────────────────────
// 1. GET /api/admin/receipts/next-number
// ─────────────────────────────────────────────────────────────
router.get("/admin/receipts/next-number", adminAuth, async (req, res) => {
  try {
    const year = new Date().getFullYear();
    const [row] = await sql`
      SELECT COALESCE(MAX(serial_no), 0) AS max_serial
      FROM receipts
    `;
    const nextSerial = Number(row?.max_serial || 0) + 1;
    const formattedNo = `MMR/REC/${year}/${String(nextSerial).padStart(4, "0")}`;

    return ok(res, {
      serial_no: nextSerial,
      receipt_no: formattedNo,
      receipt_date: new Date().toISOString().split("T")[0],
      plotting_place: "00, TRIBHUVAN KHEDA, SHESHPUR, Unnao, Uttar Pradesh - 209801, India",
    });
  } catch (err) {
    console.error("GET /api/admin/receipts/next-number error:", err);
    return fail(res, err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// 2. GET /api/admin/receipts/customer-lookup
// ─────────────────────────────────────────────────────────────
router.get("/admin/receipts/customer-lookup", adminAuth, async (req, res) => {
  try {
    const { q = "" } = req.query;
    const queryTerm = String(q || "").trim();

    if (!queryTerm) {
      return ok(res, []);
    }

    const searchPattern = `%${queryTerm.toLowerCase()}%`;
    const rows = await sql`
      SELECT user_id, member_id, full_name, mobile_no, email, user_type
      FROM users
      WHERE LOWER(COALESCE(full_name, '')) LIKE ${searchPattern}
         OR LOWER(COALESCE(mobile_no, '')) LIKE ${searchPattern}
         OR LOWER(COALESCE(member_id, '')) LIKE ${searchPattern}
         OR LOWER(COALESCE(email, '')) LIKE ${searchPattern}
      ORDER BY user_id DESC
      LIMIT 15
    `;

    return ok(res, rows);
  } catch (err) {
    console.error("GET /api/admin/receipts/customer-lookup error:", err);
    return fail(res, err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// 3. GET /api/admin/receipts (Paginated + Filtered + Summary)
// ─────────────────────────────────────────────────────────────
router.get("/admin/receipts", adminAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 25,
      search = "",
      receipt_no = "",
      invoice_no = "",
      customer_name = "",
      mobile_no = "",
      plot_no = "",
      advisor_name = "",
      payment_type = "",
      payment_mode = "",
      date_from = "",
      date_to = "",
      min_amount = "",
      max_amount = "",
      amount = "",
      plotting_place = "",
      status = "",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 25));
    const offset = (pageNum - 1) * limitNum;

    // Search condition
    let searchCond = sql`TRUE`;
    if (search && search.trim()) {
      const q = `%${search.trim().toLowerCase()}%`;
      searchCond = sql`(
        LOWER(COALESCE(receipt_no, '')) LIKE ${q} OR
        LOWER(COALESCE(customer_name, '')) LIKE ${q} OR
        LOWER(COALESCE(mobile_no, '')) LIKE ${q} OR
        LOWER(COALESCE(plot_no, '')) LIKE ${q} OR
        LOWER(COALESCE(advisor_name, '')) LIKE ${q} OR
        LOWER(COALESCE(amount_depositor_name, '')) LIKE ${q} OR
        CAST(serial_no AS TEXT) LIKE ${q} OR
        CAST(paid_amount AS TEXT) LIKE ${q}
      )`;
    }

    const recQuery = (receipt_no || invoice_no || "").trim();
    let receiptNoCond = recQuery ? sql`LOWER(receipt_no) LIKE ${`%${recQuery.toLowerCase()}%`}` : sql`TRUE`;
    let customerNameCond = customer_name && customer_name.trim() ? sql`LOWER(customer_name) LIKE ${`%${customer_name.trim().toLowerCase()}%`}` : sql`TRUE`;
    let mobileCond = mobile_no && mobile_no.trim() ? sql`mobile_no LIKE ${`%${mobile_no.trim()}%`}` : sql`TRUE`;
    let plotCond = plot_no && plot_no.trim() ? sql`LOWER(plot_no) LIKE ${`%${plot_no.trim().toLowerCase()}%`}` : sql`TRUE`;
    let advisorCond = advisor_name && advisor_name.trim() ? sql`LOWER(advisor_name) LIKE ${`%${advisor_name.trim().toLowerCase()}%`}` : sql`TRUE`;
    let payTypeCond = payment_type && payment_type.trim() ? sql`LOWER(payment_type) = ${payment_type.trim().toLowerCase()}` : sql`TRUE`;
    let payModeCond = payment_mode && payment_mode.trim() ? sql`LOWER(payment_mode) = ${payment_mode.trim().toLowerCase()}` : sql`TRUE`;
    let placeCond = plotting_place && plotting_place.trim() ? sql`LOWER(plotting_place) LIKE ${`%${plotting_place.trim().toLowerCase()}%`}` : sql`TRUE`;
    let statusCond = status && status.trim() ? sql`LOWER(status) = ${status.trim().toLowerCase()}` : sql`status != 'Deleted'`;
    let dateFromCond = date_from && date_from.trim() ? sql`receipt_date >= ${date_from.trim()}::date` : sql`TRUE`;
    let dateToCond = date_to && date_to.trim() ? sql`receipt_date <= ${date_to.trim()}::date` : sql`TRUE`;
    let minAmtCond = min_amount && !isNaN(Number(min_amount)) ? sql`paid_amount >= ${Number(min_amount)}` : sql`TRUE`;
    let maxAmtCond = max_amount && !isNaN(Number(max_amount)) ? sql`paid_amount <= ${Number(max_amount)}` : sql`TRUE`;
    let exactAmtCond = amount && !isNaN(Number(amount)) ? sql`(paid_amount = ${Number(amount)} OR receipt_amount = ${Number(amount)})` : sql`TRUE`;

    // Fetch Receipts
    const receipts = await sql`
      SELECT *
      FROM receipts
      WHERE ${searchCond}
        AND ${receiptNoCond}
        AND ${customerNameCond}
        AND ${mobileCond}
        AND ${plotCond}
        AND ${advisorCond}
        AND ${payTypeCond}
        AND ${payModeCond}
        AND ${placeCond}
        AND ${statusCond}
        AND ${dateFromCond}
        AND ${dateToCond}
        AND ${minAmtCond}
        AND ${maxAmtCond}
        AND ${exactAmtCond}
      ORDER BY id DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    // Count for pagination
    const [countRow] = await sql`
      SELECT COUNT(*) AS total
      FROM receipts
      WHERE ${searchCond}
        AND ${receiptNoCond}
        AND ${customerNameCond}
        AND ${mobileCond}
        AND ${plotCond}
        AND ${advisorCond}
        AND ${payTypeCond}
        AND ${payModeCond}
        AND ${placeCond}
        AND ${statusCond}
        AND ${dateFromCond}
        AND ${dateToCond}
        AND ${minAmtCond}
        AND ${maxAmtCond}
        AND ${exactAmtCond}
    `;

    const total = parseInt(countRow?.total || "0", 10);
    const totalPages = Math.ceil(total / limitNum) || 1;

    // Aggregate Summary KPI metrics
    const [metrics] = await sql`
      SELECT
        COUNT(*) AS total_receipts,
        COALESCE(SUM(CASE WHEN status != 'Cancelled' AND status != 'Deleted' THEN paid_amount ELSE 0 END), 0) AS total_collection,
        COALESCE(SUM(CASE WHEN receipt_date = CURRENT_DATE AND status != 'Cancelled' AND status != 'Deleted' THEN 1 ELSE 0 END), 0) AS today_receipts,
        COALESCE(SUM(CASE WHEN receipt_date = CURRENT_DATE AND status != 'Cancelled' AND status != 'Deleted' THEN paid_amount ELSE 0 END), 0) AS today_collection,
        COALESCE(SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END), 0) AS active_receipts,
        COALESCE(SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_receipts,
        COALESCE(SUM(CASE WHEN LOWER(payment_type) = 'cash' AND status != 'Deleted' THEN 1 ELSE 0 END), 0) AS cash_receipts,
        COALESCE(SUM(CASE WHEN LOWER(payment_type) = 'cheque' AND status != 'Deleted' THEN 1 ELSE 0 END), 0) AS cheque_receipts,
        COALESCE(SUM(CASE WHEN (LOWER(payment_type) LIKE '%upi%' OR LOWER(payment_type) LIKE '%online%') AND status != 'Deleted' THEN 1 ELSE 0 END), 0) AS upi_receipts
      FROM receipts
      WHERE status != 'Deleted'
    `;

    return ok(res, receipts, "Receipts fetched successfully", {
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
      },
      summary: {
        totalReceipts: Number(metrics?.total_receipts || 0),
        todayReceipts: Number(metrics?.today_receipts || 0),
        todayCollection: Number(metrics?.today_collection || 0),
        totalCollection: Number(metrics?.total_collection || 0),
        activeReceipts: Number(metrics?.active_receipts || 0),
        cancelledReceipts: Number(metrics?.cancelled_receipts || 0),
      },
    });
  } catch (err) {
    console.error("GET /api/admin/receipts error:", err);
    return fail(res, err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// 4. POST /api/admin/receipts (Create & Permanently Lock Receipt)
// ─────────────────────────────────────────────────────────────
router.post("/admin/receipts", adminAuth, async (req, res) => {
  try {
    const {
      receipt_no,
      serial_no,
      plot_no,
      plot_area,
      customer_id,
      customer_name,
      mobile_no,
      r_o_p,
      payment_type = "Cash",
      payment_mode = "Full Payment",
      cheque_no,
      cheque_date,
      bank_name,
      receipt_amount = 0,
      paid_amount = 0,
      inward_amount = 0,
      amount_depositor_name,
      advisor_name,
      advisor_mobile,
      full_payment_time,
      receipt_date,
      plotting_place = "00, TRIBHUVAN KHEDA, SHESHPUR, Unnao, Uttar Pradesh - 209801, India",
      depositor_signature,
      authorized_signature,
      notes,
    } = req.body;

    // Strict Backend Validation
    if (!customer_name || !String(customer_name).trim()) {
      return fail(res, "Customer Name is required");
    }
    if (!mobile_no || !String(mobile_no).trim()) {
      return fail(res, "Mobile Number is required");
    }
    if (!receipt_date) {
      return fail(res, "Receipt Date is required");
    }
    if (isNaN(Number(paid_amount)) || Number(paid_amount) < 0) {
      return fail(res, "Paid Amount must be a non-negative valid number");
    }
    if (payment_type === "Cheque") {
      if (!cheque_no || !String(cheque_no).trim()) {
        return fail(res, "Cheque Number is required when Payment Type is Cheque");
      }
      if (!bank_name || !String(bank_name).trim()) {
        return fail(res, "Bank Name is required when Payment Type is Cheque");
      }
    }

    const adminId = req.user?.admin_id || req.user?.user_id || req.user?.id || null;
    const adminName = req.user?.full_name || req.user?.name || "Admin";

    // Concurrency-safe serial and receipt number calculation
    let finalSerial = parseInt(serial_no, 10);
    if (isNaN(finalSerial) || finalSerial <= 0) {
      const [maxRow] = await sql`SELECT COALESCE(MAX(serial_no), 0) AS max_s FROM receipts`;
      finalSerial = Number(maxRow?.max_s || 0) + 1;
    }

    let finalReceiptNo = receipt_no && String(receipt_no).trim() ? String(receipt_no).trim() : "";
    if (!finalReceiptNo) {
      const year = new Date().getFullYear();
      finalReceiptNo = `MMR/REC/${year}/${String(finalSerial).padStart(4, "0")}`;
    }

    // Check duplicate receipt_no
    const [existing] = await sql`
      SELECT id, receipt_no FROM receipts WHERE LOWER(receipt_no) = LOWER(${finalReceiptNo}) LIMIT 1
    `;
    if (existing) {
      // Regenerate with timestamp fallback if duplicate
      const year = new Date().getFullYear();
      const [maxRow] = await sql`SELECT COALESCE(MAX(serial_no), 0) AS max_s FROM receipts`;
      finalSerial = Number(maxRow?.max_s || 0) + 1;
      finalReceiptNo = `MMR/REC/${year}/${String(finalSerial).padStart(4, "0")}`;
    }

    const [created] = await sql`
      INSERT INTO receipts (
        receipt_no, serial_no, plot_no, plot_area, customer_id, customer_name,
        mobile_no, r_o_p, payment_type, payment_mode, cheque_no, cheque_date,
        bank_name, receipt_amount, paid_amount, inward_amount, amount_depositor_name,
        advisor_name, advisor_mobile, full_payment_time, receipt_date, plotting_place,
        depositor_signature, authorized_signature, notes, status, is_locked,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        ${finalReceiptNo},
        ${finalSerial},
        ${plot_no || null},
        ${plot_area || null},
        ${customer_id ? Number(customer_id) : null},
        ${String(customer_name).trim()},
        ${String(mobile_no).trim()},
        ${r_o_p || null},
        ${payment_type || 'Cash'},
        ${payment_mode || 'Full Payment'},
        ${cheque_no || null},
        ${cheque_date ? cheque_date : null},
        ${bank_name || null},
        ${Number(receipt_amount || 0)},
        ${Number(paid_amount || 0)},
        ${Number(inward_amount || 0)},
        ${amount_depositor_name || null},
        ${advisor_name || null},
        ${advisor_mobile || null},
        ${full_payment_time ? new Date(full_payment_time) : null},
        ${receipt_date},
        ${plotting_place},
        ${depositor_signature || null},
        ${authorized_signature || null},
        ${notes || null},
        'Active',
        TRUE,
        ${adminId},
        ${adminId},
        NOW(),
        NOW()
      )
      RETURNING *
    `;

    // Audit Log
    try {
      await sql`
        INSERT INTO receipt_audit_log (
          receipt_id, receipt_no, action, performed_by, performed_by_name, details, created_at
        ) VALUES (
          ${created.id},
          ${created.receipt_no},
          'CREATED',
          ${adminId},
          ${adminName},
          ${JSON.stringify({
            amount: created.paid_amount,
            customer: created.customer_name,
            payment_type: created.payment_type,
            payment_mode: created.payment_mode
          })},
          NOW()
        )
      `;
    } catch (auditErr) {
      console.warn("Receipt audit log insertion warning:", auditErr);
    }

    return ok(res, created, `Receipt #${created.receipt_no} created and locked permanently.`);
  } catch (err) {
    console.error("POST /api/admin/receipts error:", err);
    return fail(res, err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// 5. GET /api/admin/receipts/:id (Details + Audit Trail)
// ─────────────────────────────────────────────────────────────
router.get("/admin/receipts/:id", adminAuth, async (req, res) => {
  try {
    const idOrNo = req.params.id;
    const isNumeric = /^\d+$/.test(idOrNo);

    let receipt;
    if (isNumeric) {
      [receipt] = await sql`SELECT * FROM receipts WHERE id = ${idOrNo} OR receipt_no = ${idOrNo} LIMIT 1`;
    } else {
      [receipt] = await sql`SELECT * FROM receipts WHERE LOWER(receipt_no) = LOWER(${idOrNo}) LIMIT 1`;
    }

    if (!receipt) {
      return fail(res, "Receipt not found", 404);
    }

    let auditLogs = [];
    try {
      auditLogs = await sql`
        SELECT * FROM receipt_audit_log WHERE receipt_id = ${receipt.id} ORDER BY id DESC
      `;
    } catch (auditErr) {
      console.warn("Receipt audit log query warning:", auditErr.message);
      auditLogs = [];
    }

    const amountInWords = numberToWords(receipt.paid_amount);

    return ok(res, {
      receipt,
      amountInWords,
      auditLogs,
    });
  } catch (err) {
    console.error("GET /api/admin/receipts/:id error:", err);
    return fail(res, err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// 6. PUT /api/admin/receipts/:id (Immutable / Locked Guard)
// ─────────────────────────────────────────────────────────────
router.put("/admin/receipts/:id", adminAuth, async (req, res) => {
  // Business Rule: "agar preview ke baad data save ho gya to change nahi hoga"
  return fail(res, "Receipt records are permanent and immutable. Modifying saved financial receipts is not permitted.");
});

// ─────────────────────────────────────────────────────────────
// 7. DELETE /api/admin/receipts/:id (Soft Delete / Void Receipt)
// ─────────────────────────────────────────────────────────────
router.delete("/admin/receipts/:id", adminAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const adminId = req.user?.admin_id || req.user?.user_id || req.user?.id || null;
    const adminName = req.user?.full_name || req.user?.name || "Admin";
    const reason = req.body?.reason || "Cancelled by administrator";

    const [existing] = await sql`SELECT * FROM receipts WHERE id = ${id} OR receipt_no = ${id} LIMIT 1`;
    if (!existing) {
      return fail(res, "Receipt not found", 404);
    }

    const [cancelled] = await sql`
      UPDATE receipts
      SET status = 'Cancelled',
          notes = CONCAT(COALESCE(notes, ''), ' [CANCELLED: ' || ${reason} || ' at ' || NOW()::text || ']'),
          updated_by = ${adminId},
          updated_at = NOW()
      WHERE id = ${existing.id}
      RETURNING *
    `;

    // Audit Log
    try {
      await sql`
        INSERT INTO receipt_audit_log (
          receipt_id, receipt_no, action, performed_by, performed_by_name, details, created_at
        ) VALUES (
          ${existing.id},
          ${existing.receipt_no},
          'CANCELLED',
          ${adminId},
          ${adminName},
          ${JSON.stringify({ reason })},
          NOW()
        )
      `;
    } catch (_) {}

    return ok(res, cancelled, `Receipt #${existing.receipt_no} has been cancelled successfully.`);
  } catch (err) {
    console.error("DELETE /api/admin/receipts/:id error:", err);
    return fail(res, err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// 8. GET /api/admin/receipts/:id/print (Print Payload)
// ─────────────────────────────────────────────────────────────
router.get("/admin/receipts/:id/print", adminAuth, async (req, res) => {
  try {
    const idOrNo = req.params.id;
    const isNumeric = /^\d+$/.test(idOrNo);

    let receipt;
    if (isNumeric) {
      [receipt] = await sql`SELECT * FROM receipts WHERE id = ${idOrNo} OR receipt_no = ${idOrNo} LIMIT 1`;
    } else {
      [receipt] = await sql`SELECT * FROM receipts WHERE LOWER(receipt_no) = LOWER(${idOrNo}) LIMIT 1`;
    }

    if (!receipt) {
      return fail(res, "Receipt not found", 404);
    }

    return ok(res, {
      receipt,
      amountInWords: numberToWords(receipt.paid_amount),
      companyHeader: {
        title: "MMRCONSTRUCTION AND DEVELOPERS PRIVATE LIMITED",
        addressLine1: "00, TRIBHUVAN KHEDA, SHESHPUR, Unnao, Uttar Pradesh - 209801, India",
        email: "support@mmrconstructions.in",
        contact: "9511119879",
      },
    });
  } catch (err) {
    console.error("GET /api/admin/receipts/:id/print error:", err);
    return fail(res, err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// 9. GET /api/admin/receipts/:id/pdf & /api/receipts/:id/pdf (Server-side PDFkit generation: A4 Landscape Dual-Copy)
// ─────────────────────────────────────────────────────────────
router.get(["/admin/receipts/:id/pdf", "/receipts/:id/pdf", "/customer/receipts/:id/pdf"], userAuth, async (req, res) => {
  try {
    const idOrNo = req.params.id;
    const isNumeric = /^\d+$/.test(idOrNo);

    let receipt;
    if (isNumeric) {
      [receipt] = await sql`SELECT * FROM receipts WHERE id = ${idOrNo} OR receipt_no = ${idOrNo} LIMIT 1`;
    } else {
      [receipt] = await sql`SELECT * FROM receipts WHERE LOWER(receipt_no) = LOWER(${idOrNo}) LIMIT 1`;
    }

    if (!receipt) {
      return res.status(404).send("Receipt not found");
    }

    // A4 Landscape Dimensions: 841.89 x 595.28 points
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 16,
      info: {
        Title: `Receipt-${receipt.receipt_no}`,
        Author: "MMRCONSTRUCTION AND DEVELOPERS PRIVATE LIMITED",
      },
    });

    const filename = `Receipt-${receipt.receipt_no.replace(/[\/\\]/g, "_")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    doc.pipe(res);

    const formatDate = (d) => {
      if (!d) return "—";
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return String(d);
      const day = String(dt.getDate()).padStart(2, "0");
      const month = String(dt.getMonth() + 1).padStart(2, "0");
      const year = dt.getFullYear();
      return `${day}/${month}/${year}`;
    };

    const formatCurrency = (val) => {
      const num = Number(val) || 0;
      return num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const isCancelled = receipt.status === "Cancelled";

    // Helper to render one copy card on the landscape page
    const renderCopyCard = (startX, startY, cardWidth, cardHeight, copyType) => {
      const isCustomer = copyType === "CUSTOMER COPY";
      const contentX = startX + 10;
      const contentW = cardWidth - 20;

      // Card Border & Background
      if (isCancelled) {
        doc.roundedRect(startX, startY, cardWidth, cardHeight, 6)
           .fillAndStroke("#fffafa", "#ef4444");
      } else {
        doc.roundedRect(startX, startY, cardWidth, cardHeight, 6)
           .lineWidth(1.5)
           .strokeColor("#064e3b")
           .stroke();
      }

      // Watermark if Cancelled
      if (isCancelled) {
        doc.save();
        doc.fontSize(36).font("Helvetica-Bold").fillColor("#ef4444").opacity(0.12);
        doc.rotate(-25, { origin: [startX + cardWidth / 2, startY + cardHeight / 2] });
        doc.text("CANCELLED", startX + cardWidth / 2 - 100, startY + cardHeight / 2 - 15);
        doc.restore();
      }

      // 1. Header
      let y = startY + 8;
      doc.fontSize(10).font("Helvetica-Bold").fillColor("#064e3b")
         .text("MMRCONSTRUCTION AND DEVELOPERS PRIVATE LIMITED", contentX, y, { width: contentW, align: "center" });
      y += 13;

      doc.fontSize(6.8).font("Helvetica").fillColor("#475569")
         .text("00, TRIBHUVAN KHEDA, SHESHPUR, Unnao, Uttar Pradesh - 209801, India", contentX, y, { width: contentW, align: "center" });
      y += 9;

      doc.fontSize(6.8).font("Helvetica").fillColor("#475569")
         .text("Email: support@mmrconstructions.in | Contact: 9511119879", contentX, y, { width: contentW, align: "center" });
      y += 11;

      // 2. Badges (Payment Receipt + Copy Badge)
      const b1W = 86;
      const b2W = isCustomer ? 82 : 112;
      const totalBadgesW = b1W + 6 + b2W;
      const b1X = startX + (cardWidth - totalBadgesW) / 2;
      const b2X = b1X + b1W + 6;

      // Payment Receipt Badge
      doc.roundedRect(b1X, y, b1W, 13, 3).fill("#064e3b");
      doc.fontSize(6.5).font("Helvetica-Bold").fillColor("#ffffff")
         .text("PAYMENT RECEIPT", b1X, y + 3, { width: b1W, align: "center" });

      // Copy Badge
      if (isCustomer) {
        doc.roundedRect(b2X, y, b2W, 13, 3).fillAndStroke("#ecfdf5", "#10b981");
        doc.fontSize(6.5).font("Helvetica-Bold").fillColor("#065f46")
           .text("CUSTOMER COPY", b2X, y + 3, { width: b2W, align: "center" });
      } else {
        doc.roundedRect(b2X, y, b2W, 13, 3).fillAndStroke("#eff6ff", "#3b82f6");
        doc.fontSize(6.5).font("Helvetica-Bold").fillColor("#1e40af")
           .text("COMPANY / OFFICE COPY", b2X, y + 3, { width: b2W, align: "center" });
      }
      y += 18;

      // 3. Meta Grid
      // Row 1: Receipt No & Date
      doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#1e293b")
         .text("Receipt No: ", contentX, y, { continued: true })
         .font("Helvetica").text(receipt.receipt_no || "—");

      doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#1e293b")
         .text("Date: ", contentX + 210, y, { continued: true })
         .font("Helvetica").text(formatDate(receipt.receipt_date));
      y += 12;

      // Row 2: Serial No & Plotting Place
      doc.roundedRect(contentX, y, 68, 12, 2).fill("#e0f2fe");
      doc.fontSize(6.8).font("Helvetica-Bold").fillColor("#0284c7")
         .text(`Serial No: ${receipt.serial_no || 1}`, contentX, y + 2, { width: 68, align: "center" });

      doc.fontSize(6.8).font("Helvetica-Bold").fillColor("#1e293b")
         .text("Plotting Place: ", contentX + 76, y + 1, { continued: true })
         .font("Helvetica").fillColor("#334155")
         .text(receipt.plotting_place || "00, TRIBHUVAN KHEDA, SHESHPUR, Unnao, Uttar Pradesh - 209801, India", { width: contentW - 76, height: 20 });
      y += 17;

      // Divider Line
      doc.moveTo(contentX, y).lineTo(contentX + contentW, y).lineWidth(0.7).strokeColor("#064e3b").opacity(0.4).stroke();
      doc.opacity(1.0);
      y += 5;

      // 4. Particulars Table (4 columns)
      const c1 = 88;
      const c2 = 98;
      const c3 = 88;
      const c4 = 98;
      const rowHeight = 17;

      const rows = [
        [
          { label: "Customer Name:", val: receipt.customer_name || "—", bold: true },
          { label: "Mobile No:", val: receipt.mobile_no || "—", bold: false }
        ],
        [
          { label: "R.O.P. (S/o, D/o):", val: receipt.r_o_p || "—", bold: false },
          { label: "Plot No:", val: receipt.plot_no || "—", bold: true }
        ],
        [
          { label: "Plot Area:", val: receipt.plot_area || "—", bold: false },
          { label: "Payment Mode:", val: receipt.payment_mode || "Full Payment", bold: false }
        ],
        [
          { label: "Payment Type:", val: receipt.payment_type || "Cash", bold: false },
          { label: "Amount Depositor:", val: receipt.amount_depositor_name || "—", bold: false }
        ],
      ];

      if (receipt.payment_type === "Cheque") {
        rows.push([
          { label: "Cheque No & Date:", val: `${receipt.cheque_no || "—"} (${formatDate(receipt.cheque_date)})`, bold: false },
          { label: "Bank Name:", val: receipt.bank_name || "—", bold: false }
        ]);
      }

      rows.push([
        { label: "Advisor Name:", val: receipt.advisor_name || "—", bold: false },
        { label: "Advisor Mobile:", val: receipt.advisor_mobile || "—", bold: false }
      ]);

      rows.forEach((r) => {
        // Backgrounds
        doc.rect(contentX, y, contentW, rowHeight).fillAndStroke("#ffffff", "#cbd5e1");
        doc.rect(contentX, y, c1, rowHeight).fillAndStroke("#f8fafc", "#cbd5e1");
        doc.rect(contentX + c1 + c2, y, c3, rowHeight).fillAndStroke("#f8fafc", "#cbd5e1");

        // Cell 1
        doc.fontSize(6.8).font("Helvetica-Bold").fillColor("#334155")
           .text(r[0].label, contentX + 4, y + 4.5, { width: c1 - 6 });
        doc.fontSize(6.8).font(r[0].bold ? "Helvetica-Bold" : "Helvetica").fillColor("#0f172a")
           .text(r[0].val, contentX + c1 + 4, y + 4.5, { width: c2 - 6 });

        // Cell 2
        doc.fontSize(6.8).font("Helvetica-Bold").fillColor("#334155")
           .text(r[1].label, contentX + c1 + c2 + 4, y + 4.5, { width: c3 - 6 });
        doc.fontSize(6.8).font(r[1].bold ? "Helvetica-Bold" : "Helvetica").fillColor("#0f172a")
           .text(r[1].val, contentX + c1 + c2 + c3 + 4, y + 4.5, { width: c4 - 6 });

        y += rowHeight;
      });

      y += 5;

      // 5. Financial Figures Box
      const boxH = 50;
      doc.roundedRect(contentX, y, contentW, boxH, 4).fillAndStroke("#f0fdf4", "#86efac");

      const colW = contentW / 3;
      // Col 1: Receipt Amount
      doc.fontSize(6.2).font("Helvetica-Bold").fillColor("#64748b")
         .text("Receipt Amount", contentX, y + 4, { width: colW, align: "center" });
      doc.fontSize(8).font("Helvetica-Bold").fillColor("#334155")
         .text(`Rs. ${formatCurrency(receipt.receipt_amount)}`, contentX, y + 12.5, { width: colW, align: "center" });

      // Col 2: Paid Amount
      doc.fontSize(6.2).font("Helvetica-Bold").fillColor("#166534")
         .text("Paid Amount", contentX + colW, y + 4, { width: colW, align: "center" });
      doc.fontSize(8.5).font("Helvetica-Bold").fillColor("#16a34a")
         .text(`Rs. ${formatCurrency(receipt.paid_amount)}`, contentX + colW, y + 12.5, { width: colW, align: "center" });

      // Col 3: Inward Amount
      doc.fontSize(6.2).font("Helvetica-Bold").fillColor("#64748b")
         .text("Inward Amount", contentX + colW * 2, y + 4, { width: colW, align: "center" });
      doc.fontSize(8).font("Helvetica-Bold").fillColor("#0284c7")
         .text(`Rs. ${formatCurrency(receipt.inward_amount)}`, contentX + colW * 2, y + 12.5, { width: colW, align: "center" });

      // Divider inside amount box
      doc.save();
      doc.moveTo(contentX + 6, y + 25).lineTo(contentX + contentW - 6, y + 25).dash(2, { space: 2 }).lineWidth(0.5).strokeColor("#86efac").stroke();
      doc.restore();

      // Amount in Words
      doc.fontSize(6.2).font("Helvetica-Bold").fillColor("#166534")
         .text("Amount in Words: ", contentX + 8, y + 29, { continued: true })
         .font("Helvetica-Oblique").fillColor("#15803d")
         .text(numberToWords(receipt.paid_amount), { width: contentW - 16 });

      y += boxH + 5;

      // 6. Notes if present
      if (receipt.notes) {
        doc.fontSize(5.8).font("Helvetica-Bold").fillColor("#475569")
           .text("Notes / Terms: ", contentX, y, { continued: true })
           .font("Helvetica").fillColor("#334155")
           .text(receipt.notes, { width: contentW });
        y += 10;
      }

      // 7. Terms Disclaimer
      doc.fontSize(5.5).font("Helvetica-Oblique").fillColor("#64748b")
         .text("* This receipt is a verified acknowledgment of payment for MMRCONSTRUCTION AND DEVELOPERS PRIVATE LIMITED. All payments via cheque are subject to clearance.", contentX, y, { width: contentW });

      // 8. Signatures Section (at bottom of card)
      const sigY = startY + cardHeight - 38;

      // Left Signature (Depositor)
      doc.moveTo(contentX + 8, sigY).lineTo(contentX + 115, sigY).lineWidth(0.8).strokeColor("#334155").stroke();
      doc.fontSize(6.5).font("Helvetica-Bold").fillColor("#0f172a")
         .text("Depositor's Signature", contentX + 8, sigY + 3, { width: 107, align: "center" });

      // Right Signature (Authorized Signatory)
      doc.moveTo(contentX + contentW - 150, sigY).lineTo(contentX + contentW - 8, sigY).lineWidth(0.8).strokeColor("#334155").stroke();
      doc.fontSize(6.5).font("Helvetica-Bold").fillColor("#0f172a")
         .text("Authorized Signatory", contentX + contentW - 150, sigY + 3, { width: 142, align: "center" });
      doc.fontSize(5.4).font("Helvetica").fillColor("#64748b")
         .text("MMRCONSTRUCTION AND DEVELOPERS PRIVATE LIMITED", contentX + contentW - 150, sigY + 12, { width: 142, align: "center" });
    };

    const cardWidth = 394;
    const cardHeight = 563;
    const topY = 16;
    const leftCardX = 16;
    const rightCardX = 431.89;

    // Render Left Copy: CUSTOMER COPY
    renderCopyCard(leftCardX, topY, cardWidth, cardHeight, "CUSTOMER COPY");

    // Render Center Cut Divider
    const cutX = 420.94;
    doc.save();
    doc.moveTo(cutX, 22).lineTo(cutX, 275).dash(3, { space: 3 }).lineWidth(1).strokeColor("#94a3b8").stroke();
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#64748b").text("- - [ CUT HERE ] - -", cutX - 45, 286, { width: 90, align: "center" });
    doc.moveTo(cutX, 305).lineTo(cutX, 570).dash(3, { space: 3 }).lineWidth(1).strokeColor("#94a3b8").stroke();
    doc.restore();

    // Render Right Copy: COMPANY / OFFICE COPY
    renderCopyCard(rightCardX, topY, cardWidth, cardHeight, "COMPANY / OFFICE COPY");

    doc.end();
  } catch (err) {
    console.error("GET /api/admin/receipts/:id/pdf error:", err);
    if (!res.headersSent) {
      res.status(500).send("Error generating PDF receipt");
    }
  }
});

export default router;
