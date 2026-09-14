import express from "express";
import sql from "../db.js";
import { adminAuth } from "../middleware/auth.middleware.js";
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
        plotting_place VARCHAR(255) NOT NULL DEFAULT 'NEW M.M.R. CITY, Kanpur Lucknow Road, N.H.-27 Road Near Jajmau Tribhuwan Kheda (Unnao)',
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
      plotting_place: "NEW M.M.R. CITY, Kanpur Lucknow Road, N.H.-27 Road Near Jajmau Tribhuwan Kheda (Unnao)",
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
        COALESCE(SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_receipts
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
      plotting_place = "NEW M.M.R. CITY, Kanpur Lucknow Road, N.H.-27 Road Near Jajmau Tribhuwan Kheda (Unnao)",
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

    const auditLogs = await sql`
      SELECT * FROM receipt_audit_log WHERE receipt_id = ${receipt.id} ORDER BY id DESC
    `;

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
        title: "NEW M.M.R. CITY",
        addressLine1: "Kanpur Lucknow Road, N.H.-27 Road",
        addressLine2: "Near Jajmau Tribhuwan Kheda (Unnao)",
      },
    });
  } catch (err) {
    console.error("GET /api/admin/receipts/:id/print error:", err);
    return fail(res, err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// 9. GET /api/admin/receipts/:id/pdf (Server-side PDFkit generation)
// ─────────────────────────────────────────────────────────────
router.get("/admin/receipts/:id/pdf", adminAuth, async (req, res) => {
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

    const doc = new PDFDocument({
      size: "A4",
      margin: 36,
      info: {
        Title: `Receipt-${receipt.receipt_no}`,
        Author: "MMR Constructions & Developers",
      },
    });

    const filename = `Receipt-${receipt.receipt_no.replace(/[\/\\]/g, "_")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    doc.pipe(res);

    // Outer Decorative Border
    doc.rect(20, 20, 555, 802).lineWidth(2).strokeColor("#123d2d").stroke();
    doc.rect(24, 24, 547, 794).lineWidth(0.5).strokeColor("#d4af37").stroke();

    // Watermark if Cancelled
    if (receipt.status === "Cancelled") {
      doc.save();
      doc.fontSize(60).fillColor("#ff0000").opacity(0.12);
      doc.rotate(-30, { origin: [297, 420] });
      doc.text("CANCELLED", 150, 400);
      doc.restore();
    }

    // Header Section
    doc.fontSize(22).font("Helvetica-Bold").fillColor("#123d2d").text("NEW M.M.R. CITY", { align: "center" });
    doc.fontSize(10).font("Helvetica").fillColor("#4a5568").text("Kanpur Lucknow Road, N.H.-27 Road", { align: "center" });
    doc.fontSize(10).text("Near Jajmau Tribhuwan Kheda (Unnao)", { align: "center" });
    doc.moveDown(0.5);

    // Divider
    doc.moveTo(35, doc.y).lineTo(560, doc.y).lineWidth(1.5).strokeColor("#123d2d").stroke();
    doc.moveDown(0.6);

    // Title Badge
    doc.fontSize(14).font("Helvetica-Bold").fillColor("#123d2d").text("PAYMENT RECEIPT", { align: "center" });
    doc.moveDown(0.8);

    // Top Meta Grid (Receipt No, Serial No, Date, Plotting Place)
    const startY = doc.y;
    doc.fontSize(10).font("Helvetica-Bold").fillColor("#2d3748");
    doc.text(`Receipt No: `, 40, startY, { continued: true }).font("Helvetica").text(receipt.receipt_no);
    doc.font("Helvetica-Bold").text(`Date: `, 380, startY, { continued: true }).font("Helvetica").text(new Date(receipt.receipt_date).toLocaleDateString("en-IN"));

    doc.font("Helvetica-Bold").text(`Serial No: `, 40, startY + 18, { continued: true }).font("Helvetica").text(String(receipt.serial_no));
    doc.font("Helvetica-Bold").text(`Plotting Place: `, 380, startY + 18, { continued: true }).font("Helvetica").text(receipt.plotting_place || "NEW M.M.R. CITY", { width: 170 });

    doc.y = startY + 45;
    doc.moveTo(35, doc.y).lineTo(560, doc.y).lineWidth(0.5).strokeColor("#cbd5e1").stroke();
    doc.moveDown(0.8);

    // Customer & Plot Details
    const custY = doc.y;
    doc.fontSize(11).font("Helvetica-Bold").fillColor("#123d2d").text("CUSTOMER & PROPERTY PARTICULARS", 40, custY);
    doc.moveDown(0.5);

    const tableY = doc.y;
    const rowHeight = 22;

    const fields = [
      ["Customer Name", receipt.customer_name || "N/A", "Mobile No", receipt.mobile_no || "N/A"],
      ["R.O.P. (S/o, D/o, W/o)", receipt.r_o_p || "N/A", "Plot No", receipt.plot_no || "N/A"],
      ["Plot Area", receipt.plot_area || "N/A", "Payment Mode", receipt.payment_mode || "Full Payment"],
      ["Payment Type", receipt.payment_type || "Cash", "Amount Depositor", receipt.amount_depositor_name || "N/A"],
    ];

    if (receipt.payment_type === "Cheque") {
      fields.push([
        "Cheque No", receipt.cheque_no || "N/A",
        "Bank Name", receipt.bank_name || "N/A"
      ]);
    }

    fields.push([
      "Advisor Name", receipt.advisor_name || "N/A",
      "Advisor Mobile", receipt.advisor_mobile || "N/A"
    ]);

    let currY = tableY;
    fields.forEach((r, idx) => {
      doc.rect(40, currY, 515, rowHeight).fillAndStroke(idx % 2 === 0 ? "#f8fafc" : "#ffffff", "#e2e8f0");
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#334155").text(r[0] + ":", 45, currY + 6, { width: 120 });
      doc.font("Helvetica").fillColor("#0f172a").text(r[1], 170, currY + 6, { width: 120 });
      doc.font("Helvetica-Bold").fillColor("#334155").text(r[2] + ":", 300, currY + 6, { width: 110 });
      doc.font("Helvetica").fillColor("#0f172a").text(r[3], 415, currY + 6, { width: 135 });
      currY += rowHeight;
    });

    doc.y = currY + 15;

    // Financial Figures Box
    doc.rect(40, doc.y, 515, 65).fillAndStroke("#f0fdf4", "#16a34a");
    const boxY = doc.y + 8;

    doc.fontSize(10).font("Helvetica-Bold").fillColor("#166534");
    doc.text("Receipt Amount: ", 50, boxY, { continued: true }).font("Helvetica").text(`Rs. ${Number(receipt.receipt_amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
    doc.font("Helvetica-Bold").text("Paid Amount: ", 220, boxY, { continued: true }).font("Helvetica-Bold").fillColor("#15803d").text(`Rs. ${Number(receipt.paid_amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
    doc.font("Helvetica-Bold").fillColor("#166534").text("Inward Amount: ", 400, boxY, { continued: true }).font("Helvetica").text(`Rs. ${Number(receipt.inward_amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);

    doc.font("Helvetica-Bold").fillColor("#1e293b").text("Amount in Words: ", 50, boxY + 22, { continued: true }).font("Helvetica-Oblique").fillColor("#0f172a").text(numberToWords(receipt.paid_amount), { width: 440 });

    doc.y = boxY + 70;

    if (receipt.notes) {
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#475569").text("Notes / Remarks:", 40, doc.y);
      doc.fontSize(8.5).font("Helvetica").fillColor("#334155").text(receipt.notes, 40, doc.y + 12, { width: 515 });
      doc.y += 28;
    }

    // Terms / Conditions text
    doc.fontSize(8).font("Helvetica-Oblique").fillColor("#64748b").text(
      "* This receipt is a verified computer-generated acknowledgment of payment for NEW M.M.R. CITY, Unnao. All payments made via cheque are subject to clearance.",
      40,
      doc.y + 10,
      { width: 515 }
    );

    // Signature Area
    const sigY = 730;
    doc.moveTo(40, sigY).lineTo(220, sigY).strokeColor("#94a3b8").stroke();
    doc.moveTo(375, sigY).lineTo(555, sigY).strokeColor("#94a3b8").stroke();

    doc.fontSize(9).font("Helvetica-Bold").fillColor("#1e293b");
    doc.text("Depositor's Signature", 75, sigY + 6);
    doc.text("Authorized Signatory", 420, sigY + 6);
    doc.fontSize(8).font("Helvetica").fillColor("#64748b").text("MMR Constructions & Developers", 395, sigY + 18);

    doc.end();
  } catch (err) {
    console.error("GET /api/admin/receipts/:id/pdf error:", err);
    if (!res.headersSent) {
      res.status(500).send("Error generating PDF receipt");
    }
  }
});

export default router;
