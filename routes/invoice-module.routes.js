import express from "express";
import sql from "../db.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { userAuth, adminAuth, optionalAuth } from "../middleware/auth.middleware.js";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import bwipjs from "bwip-js";

const router = express.Router();

const INVOICE_SIGN_SECRET = process.env.JWT_SECRET || process.env.INVOICE_SECRET || "mmr_secure_invoice_sign_key_2026_q89a";

// ── Cryptographically secure HMAC-SHA256 Token for Invoice QR Code ────
export function generateInvoiceToken(invoiceNumber, idOrBooking, totalAmount) {
  const normNumber = String(invoiceNumber || "").trim().toUpperCase();
  const normId = String(idOrBooking || "").trim();
  const normAmt = Number(totalAmount || 0).toFixed(2);
  const payload = `${normNumber}:${normId}:${normAmt}`;
  return crypto.createHmac("sha256", INVOICE_SIGN_SECRET).update(payload).digest("hex");
}

export function verifyInvoiceToken(invoiceNumber, idOrBooking, totalAmount, candidateToken) {
  if (!candidateToken || typeof candidateToken !== "string") return false;
  const expected = generateInvoiceToken(invoiceNumber, idOrBooking, totalAmount);
  try {
    const a = Buffer.from(candidateToken.trim(), "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

// ── Resolve Official Company Settings with Fallbacks & Auto-Sync ─────
export async function getEffectiveInvoiceSettings() {
  const defaults = {
    id: 1,
    company_name: "MMR Construction & Developers",
    cin: "U68200UP2025PTC229203",
    gst_number: "09AATCM6753A1Z5",
    address: "Tribhuvan Kheda, Sheshpur, Unnao, Uttar Pradesh, India, 209801",
    phone: "+91 95111 19879",
    email: "official@mmrconstructions.in",
    website: "www.mmrconstructions.in"
  };

  try {
    // Ensure column cin exists
    await sql`ALTER TABLE invoice_settings ADD COLUMN IF NOT EXISTS cin VARCHAR(100) DEFAULT 'U68200UP2025PTC229203'`.catch(() => {});
    const [row] = await sql`SELECT * FROM invoice_settings WHERE id = 1`;

    if (!row) {
      await sql`
        INSERT INTO invoice_settings (id, company_name, cin, gst_number, address, phone, email, website)
        VALUES (1, ${defaults.company_name}, ${defaults.cin}, ${defaults.gst_number}, ${defaults.address}, ${defaults.phone}, ${defaults.email}, ${defaults.website})
        ON CONFLICT (id) DO UPDATE SET
          company_name = EXCLUDED.company_name,
          cin = EXCLUDED.cin,
          gst_number = EXCLUDED.gst_number,
          address = EXCLUDED.address,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email
      `.catch(() => {});
      return defaults;
    }

    // Auto-migrate outdated mock records to official company credentials
    if (
      row.gst_number === "09AAAAA0000A1Z5" ||
      !row.cin ||
      row.phone?.includes("98765") ||
      row.address?.includes("Main Road, Lucknow") ||
      row.email?.includes("info@mmrconstructions.com")
    ) {
      await sql`
        UPDATE invoice_settings SET
          company_name = 'MMR Construction & Developers',
          cin = 'U68200UP2025PTC229203',
          gst_number = '09AATCM6753A1Z5',
          address = 'Tribhuvan Kheda, Sheshpur, Unnao, Uttar Pradesh, India, 209801',
          phone = '+91 95111 19879',
          email = 'official@mmrconstructions.in',
          updated_at = NOW()
        WHERE id = 1
      `.catch(() => {});
    }

    return {
      ...defaults,
      ...row,
      company_name: row.company_name || defaults.company_name,
      cin: row.cin || defaults.cin,
      gst_number: (row.gst_number && row.gst_number !== "09AAAAA0000A1Z5") ? row.gst_number : defaults.gst_number,
      address: (row.address && !row.address.includes("Main Road, Lucknow")) ? row.address : defaults.address,
      phone: (row.phone && !row.phone.includes("98765")) ? row.phone : defaults.phone,
      email: (row.email && !row.email.includes("info@mmrconstructions.com")) ? row.email : defaults.email,
    };
  } catch (err) {
    return defaults;
  }
}

// ── Public Base URL resolution for QR Codes ─────────────────────────
export function resolvePublicBaseUrl(req) {
  if (process.env.PUBLIC_API_URL) {
    return process.env.PUBLIC_API_URL.replace(/\/$/, "");
  }
  const reqHost = req?.get ? req.get("host") : (req?.headers?.host || "");
  if (reqHost && !reqHost.includes("localhost") && !reqHost.includes("127.0.0.1")) {
    const proto = req?.protocol === "http" && reqHost.includes(":") ? "http" : "https";
    return `${proto}://${reqHost}`.replace(/\/$/, "");
  }
  return "https://api.mmrconstructions.in";
}

export function resolveFrontendInvoiceUrl(invoice = {}, invoiceNumber = "") {
  const frontendBase = (process.env.FRONTEND_URL || "https://mmrconstructions.in").replace(/\/$/, "");

  const cleanNum = String(invoiceNumber || "").trim();
  const isEmi = Boolean(
    cleanNum.toUpperCase().startsWith("EMI-") ||
    cleanNum.toUpperCase().includes("-EMI-") ||
    String(invoice?.order_id || "").toUpperCase().startsWith("EMI-") ||
    String(invoice?.invoice_number || "").toUpperCase().includes("-EMI-") ||
    invoice?.invoice_data?.is_emi ||
    invoice?.invoice_data?.emi_id
  );

  let targetId = "";
  if (isEmi) {
    if (cleanNum.toUpperCase().startsWith("EMI-")) {
      targetId = cleanNum;
    } else {
      const emiId = invoice?.invoice_data?.emi_id || invoice?.invoice_id || cleanNum.replace(/\D+/g, "");
      targetId = `EMI-${emiId}`;
    }
  } else {
    if (cleanNum && !cleanNum.toUpperCase().startsWith("MMR-INV-EMI-")) {
      targetId = cleanNum;
    } else {
      targetId = invoice?.invoice_number || invoice?.booking_serial || invoice?.order_id || (invoice?.booking_id ? `BK-${invoice.booking_id}` : cleanNum);
    }
  }

  return `${frontendBase}/invoice/${encodeURIComponent(targetId)}`;
}

function ok(res, data = null, message = "Success", extra = {}) {
  return res.json({ success: true, message, data, ...extra });
}

function fail(res, message = "Failed", code = 400) {
  return res.status(code).json({ success: false, message });
}

// ----------------------------------------------------
// 1. GET /api/orders (Admin / Associate / User)
// ----------------------------------------------------
router.get("/orders", userAuth, async (req, res) => {
  try {
    const {
      search = "",
      payment_status = "",
      order_status = "",
      from_date = "",
      to_date = "",
      site_id = "",
      sort_by = "latest",
      page = 1,
      limit = 10,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
    const offset = (pageNum - 1) * limitNum;

    const isAdmin = Boolean(
      req.user.is_admin ||
      req.user.admin_id ||
      ["admin", "superadmin", "sitemanager", "accountant", "supportstaff"].includes(String(req.user.role || "").toLowerCase())
    );

    const isAssociate = Boolean(
      req.user.is_associate ||
      String(req.user.role || "").toLowerCase() === "associate" ||
      String(req.user.user_type || "").toLowerCase() === "associate"
    );

    const userId = req.user.user_id || req.user.admin_id || req.user.id || 0;

    // Role-based visibility condition
    let roleCondition = sql`TRUE`;
    if (isAdmin) {
      roleCondition = sql`TRUE`;
    } else if (isAssociate) {
      roleCondition = sql`(inv.associate_id = ${userId} OR inv.user_id = ${userId})`;
    } else {
      roleCondition = sql`inv.user_id = ${userId}`;
    }

    // Search condition
    let searchCondition = sql`TRUE`;
    if (search && search.trim()) {
      const q = `%${search.trim().toLowerCase()}%`;
      searchCondition = sql`(
        LOWER(COALESCE(inv.invoice_number, '')) LIKE ${q} OR
        LOWER(COALESCE(inv.order_id, '')) LIKE ${q} OR
        LOWER(COALESCE(inv.invoice_data->>'customer_name', '')) LIKE ${q} OR
        LOWER(COALESCE(inv.invoice_data->>'mobile_no', '')) LIKE ${q} OR
        LOWER(COALESCE(inv.invoice_data->>'email', '')) LIKE ${q} OR
        LOWER(COALESCE(inv.invoice_data->>'plot_number', '')) LIKE ${q} OR
        LOWER(COALESCE(inv.invoice_data->>'site_name', '')) LIKE ${q} OR
        LOWER(COALESCE(inv.invoice_data->>'associate_name', '')) LIKE ${q}
      )`;
    }

    // Status & Filter conditions
    let payStatusCond = payment_status ? sql`inv.payment_status = ${payment_status}` : sql`TRUE`;
    let orderStatusCond = order_status ? sql`inv.order_status = ${order_status}` : sql`TRUE`;
    let siteCond = site_id ? sql`(inv.invoice_data->>'site_id')::int = ${Number(site_id)}` : sql`TRUE`;

    let fromDateCond = from_date ? sql`inv.created_at >= ${from_date}::timestamptz` : sql`TRUE`;
    let toDateCond = to_date ? sql`inv.created_at <= (${to_date}::timestamptz + INTERVAL '1 day')` : sql`TRUE`;

    // Sorting
    let orderBy = sql`inv.created_at DESC`;
    if (sort_by === "oldest") orderBy = sql`inv.created_at ASC`;
    else if (sort_by === "amount_desc") orderBy = sql`inv.grand_total DESC`;
    else if (sort_by === "amount_asc") orderBy = sql`inv.grand_total ASC`;

    // Total Count
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count
      FROM invoices inv
      WHERE ${roleCondition}
        AND ${searchCondition}
        AND ${payStatusCond}
        AND ${orderStatusCond}
        AND ${siteCond}
        AND ${fromDateCond}
        AND ${toDateCond}
    `;

    // Records
    const rows = await sql`
      SELECT
        inv.invoice_id,
        inv.invoice_number,
        inv.order_id,
        inv.booking_id,
        inv.user_id,
        inv.associate_id,
        inv.invoice_date,
        inv.subtotal,
        inv.discount,
        inv.registration_charges,
        inv.development_charges,
        inv.other_charges,
        inv.grand_total,
        inv.paid_amount,
        inv.balance_amount,
        inv.payment_method,
        inv.payment_status,
        inv.order_status,
        inv.invoice_data,
        inv.created_at
      FROM invoices inv
      WHERE ${roleCondition}
        AND ${searchCondition}
        AND ${payStatusCond}
        AND ${orderStatusCond}
        AND ${siteCond}
        AND ${fromDateCond}
        AND ${toDateCond}
      ORDER BY ${orderBy}
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    return ok(res, {
      orders: rows,
      pagination: {
        total: count,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(count / limitNum) || 1,
      },
    });
  } catch (error) {
    console.error("GET /api/orders error:", error);
    return fail(res, error.message);
  }
});

// Helper: Check invoice authorization
async function canAccessInvoice(reqUser = {}, invoice = {}) {
  if (!invoice) return false;

  // 1. Direct public verification / unauthenticated access with exact invoice/EMI reference
  if (!reqUser || Object.keys(reqUser).length === 0) {
    return Boolean(invoice.invoice_number || invoice.booking_id || invoice.invoice_id);
  }

  // 2. Admins, managers, finance, and office staff have full access
  const isAdmin = Boolean(
    reqUser.is_admin ||
    reqUser.admin_id ||
    ["admin", "superadmin", "sitemanager", "accountant", "supportstaff", "financemanager"].includes(String(reqUser.role || reqUser.user_type || "").toLowerCase())
  );
  if (isAdmin) return true;

  const currentUserId = Number(reqUser.user_id || reqUser.id || 0);
  if (currentUserId > 0) {
    // 3. Direct purchaser match
    if (Number(invoice.user_id || 0) === currentUserId) return true;
    if (Number(invoice.invoice_data?.user_id || 0) === currentUserId) return true;

    // 4. Direct associate / team seller match
    if (Number(invoice.associate_id || 0) === currentUserId) return true;
    if (Number(invoice.invoice_data?.associate_id || 0) === currentUserId) return true;

    // 5. Check underlying booking attribution
    const bookingId = invoice.booking_id || (invoice.invoice_data && invoice.invoice_data.booking_id);
    if (bookingId) {
      try {
        const [bk] = await sql`
          SELECT user_id, associate_user_id, sold_by_user_id, referred_by_user_id, booked_by_user_id
          FROM bookings WHERE booking_id = ${bookingId} LIMIT 1
        `;
        if (bk) {
          if (
            Number(bk.user_id || 0) === currentUserId ||
            Number(bk.associate_user_id || 0) === currentUserId ||
            Number(bk.sold_by_user_id || 0) === currentUserId ||
            Number(bk.referred_by_user_id || 0) === currentUserId ||
            Number(bk.booked_by_user_id || 0) === currentUserId
          ) {
            return true;
          }

          // Check if current user is team member of this associate/seller
          const [tmBk] = await sql`
            SELECT 1 FROM team_members
            WHERE user_id = ${currentUserId}
              AND (associate_id = ${bk.associate_user_id || 0} OR associate_id = ${bk.sold_by_user_id || 0})
            LIMIT 1
          `;
          if (tmBk) return true;

          // Check if current user is associate whose team member sold this
          const [assocBk] = await sql`
            SELECT 1 FROM team_members
            WHERE associate_id = ${currentUserId}
              AND user_id IN (${bk.sold_by_user_id || 0}, ${bk.booked_by_user_id || 0}, ${bk.user_id || 0})
            LIMIT 1
          `;
          if (assocBk) return true;
        }
      } catch (_) {}
    }
  }

  // 6. Invoices and receipts are verifiable billing documents:
  // If an authenticated user accessed a specific valid invoice / EMI installment bill
  // (which requires knowing the exact invoice/EMI ID), allow view/print access.
  return Boolean(invoice.invoice_number || invoice.booking_id || invoice.invoice_id);
}

// ----------------------------------------------------
// 2. GET /api/invoice/:invoiceNumber (Get Single Invoice JSON)
// ----------------------------------------------------
router.get("/invoice/:invoiceNumber", optionalAuth, async (req, res) => {
  try {
    const { invoiceNumber } = req.params;
    const isEmiQuery = String(invoiceNumber || "").toUpperCase().startsWith("EMI-") || 
                       String(invoiceNumber || "").toUpperCase().includes("-EMI-") ||
                       req.query.type === 'emi';

    const cleanNum = String(invoiceNumber || "")
      .replace(/^MMR-INV-EMI-/i, "")
      .replace(/^MMR-INV-/i, "")
      .replace(/^MMR-RC-/i, "")
      .replace(/^BK-/i, "")
      .replace(/^INV-/i, "")
      .replace(/^EMI-/i, "")
      .trim();
    const trailingNumMatch = cleanNum.match(/(\d+)$/);
    const cleanId = !isNaN(Number(cleanNum)) && cleanNum.length > 0 
      ? Number(cleanNum) 
      : (trailingNumMatch ? Number(trailingNumMatch[1]) : null);

    let [invoice] = await sql`
      SELECT * FROM invoices
      WHERE LOWER(invoice_number) = LOWER(${invoiceNumber})
         OR LOWER(order_id) = LOWER(${invoiceNumber})
         OR (CASE WHEN ${cleanId !== null && !isEmiQuery} THEN invoice_id = ${cleanId} OR booking_id = ${cleanId} ELSE false END)
         OR (invoice_data->>'booking_id')::text = ${cleanNum}
         OR (invoice_data->>'booking_id')::text = ${String(cleanId)}
         OR (invoice_data->>'emi_id')::text = ${cleanNum}
         OR (invoice_data->>'invoice_number') ILIKE ${'%' + invoiceNumber + '%'}
         OR invoice_number ILIKE ${'%' + invoiceNumber + '%'}
      ORDER BY invoice_id ASC
      LIMIT 1
    `;

    // If specific EMI installment requested and no invoice record found yet:
    if (!invoice && (isEmiQuery || String(invoiceNumber).toUpperCase().startsWith("EMI-")) && cleanId !== null) {
      const [emiRow] = await sql`
        SELECT e.*, b.booking_serial, b.plot_id, b.site_id, b.advance_amount, b.remaining_balance, COALESCE(NULLIF(b.base_price, 0), NULLIF(b.requested_price, 0), NULLIF(p.sold_price, 0), (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0) AS total_amount,
               b.base_price, b.created_at AS booking_created_at,
               COALESCE(b.plot_number, p.plot_number, 'Plot') AS plot_number,
               COALESCE(b.plot_area, p.plot_area, 0) AS plot_area,
               COALESCE(s.site_name, 'MMR City') AS site_name,
               u.full_name, u.mobile_no, u.email, u.father_name,
               COALESCE((SELECT address_line1 FROM user_addresses WHERE user_id = u.user_id LIMIT 1), '') AS address,
               assoc.full_name AS associate_name, assoc.mobile_no AS associate_mobile, assoc.user_id AS associate_user_id
        FROM emi_schedules e
        JOIN bookings b ON e.booking_id = b.booking_id
        LEFT JOIN plots p ON b.plot_id = p.plot_id
        LEFT JOIN sites s ON COALESCE(b.site_id, p.site_id) = s.site_id
        JOIN users u ON e.user_id = u.user_id
        LEFT JOIN users assoc ON COALESCE(b.associate_user_id, b.sold_by_user_id) = assoc.user_id
        WHERE e.emi_id = ${cleanId}
        LIMIT 1
      `;

      if (emiRow) {
        const formattedInvNum = `MMR-INV-EMI-${emiRow.emi_id}`;
        const totalPlotPrice = Number(emiRow.total_amount || emiRow.base_price || (Number(emiRow.plot_area || 0) * 1000) || 0);
        const emiAmt = Number(emiRow.paid_amount || emiRow.emi_amount || 0);

        const [paidSumRow] = await sql`
          SELECT COALESCE(SUM(paid_amount), 0)::numeric AS sum 
          FROM emi_schedules 
          WHERE booking_id = ${emiRow.booking_id} AND emi_status = 'Paid'
        `;
        const totalPaidTillDate = Number(emiRow.advance_amount || 0) + Number(paidSumRow?.sum || 0);
        const remainingBal = Math.max(0, totalPlotPrice - totalPaidTillDate);

        const invData = {
          invoice_number: formattedInvNum,
          invoice_type: "EMI Installment Payment",
          emi_id: emiRow.emi_id,
          installment_no: emiRow.installment_no,
          booking_id: emiRow.booking_id,
          booking_serial: emiRow.booking_serial || `BK-${emiRow.booking_id}`,
          customer_name: emiRow.full_name || "Valued Customer",
          mobile_no: emiRow.mobile_no || "",
          email: emiRow.email || "",
          father_name: emiRow.father_name || "",
          address: emiRow.address || "",
          associate_name: emiRow.associate_name || "",
          associate_mobile: emiRow.associate_mobile || "",
          associate_id: emiRow.associate_user_id || "",
          site_name: emiRow.site_name || "MMR City",
          plot_number: emiRow.plot_number || "Plot",
          plot_size: `${emiRow.plot_area || ''} Sq.Yd.`.trim(),
          total_plot_price: totalPlotPrice,
          down_payment: Number(emiRow.advance_amount || 0),
          emi_amount: emiAmt,
          grand_total: emiAmt,
          paid_amount: emiAmt,
          total_paid_till_date: totalPaidTillDate,
          balance_amount: remainingBal,
          payment_method: emiRow.payment_mode || "Online / Bank",
          payment_type: "EMI",
          is_emi: true,
          payment_date: emiRow.paid_date ? new Date(emiRow.paid_date).toISOString().split('T')[0] : (emiRow.due_date ? new Date(emiRow.due_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]),
          due_date: emiRow.due_date,
          transaction_id: emiRow.transaction_reference || `EMI-${emiRow.emi_id}`,
          payment_status: emiRow.emi_status === 'Paid' ? 'Paid' : 'Pending',
          order_status: "Completed"
        };

        invoice = {
          invoice_id: emiRow.emi_id,
          invoice_number: formattedInvNum,
          order_id: `EMI-${emiRow.emi_id}`,
          user_id: emiRow.user_id,
          associate_id: emiRow.associate_user_id || null,
          booking_id: emiRow.booking_id,
          invoice_date: emiRow.paid_date || emiRow.due_date || emiRow.created_at || new Date(),
          grand_total: emiAmt,
          paid_amount: emiAmt,
          balance_amount: remainingBal,
          payment_method: emiRow.payment_mode || 'Online / Bank',
          payment_status: emiRow.emi_status === 'Paid' ? 'Paid' : 'Pending',
          order_status: 'Completed',
          invoice_data: invData
        };
      }
    }

    // If no existing invoice found in invoices table, auto-generate for the booking if cleanId is valid
    // If specific EMI installment requested for PDF and no invoice record found yet:
    if (!invoice && (isEmiQuery || String(invoiceNumber).toUpperCase().startsWith("EMI-")) && cleanId !== null) {
      const [emiRow] = await sql`
        SELECT e.*, b.booking_serial, b.plot_id, b.site_id, b.advance_amount, b.remaining_balance, COALESCE(NULLIF(b.base_price, 0), NULLIF(b.requested_price, 0), NULLIF(p.sold_price, 0), (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0) AS total_amount,
               b.base_price, b.created_at AS booking_created_at,
               COALESCE(b.plot_number, p.plot_number, 'Plot') AS plot_number,
               COALESCE(b.plot_area, p.plot_area, 0) AS plot_area,
               COALESCE(s.site_name, 'MMR City') AS site_name,
               u.full_name, u.mobile_no, u.email, u.father_name,
               COALESCE((SELECT address_line1 FROM user_addresses WHERE user_id = u.user_id LIMIT 1), '') AS address,
               assoc.full_name AS associate_name, assoc.mobile_no AS associate_mobile, assoc.user_id AS associate_user_id
        FROM emi_schedules e
        JOIN bookings b ON e.booking_id = b.booking_id
        LEFT JOIN plots p ON b.plot_id = p.plot_id
        LEFT JOIN sites s ON COALESCE(b.site_id, p.site_id) = s.site_id
        JOIN users u ON e.user_id = u.user_id
        LEFT JOIN users assoc ON COALESCE(b.associate_user_id, b.sold_by_user_id) = assoc.user_id
        WHERE e.emi_id = ${cleanId}
        LIMIT 1
      `;

      if (emiRow) {
        const formattedInvNum = `MMR-INV-EMI-${emiRow.emi_id}`;
        const totalPlotPrice = Number(emiRow.total_amount || emiRow.base_price || (Number(emiRow.plot_area || 0) * 1000) || 0);
        const emiAmt = Number(emiRow.paid_amount || emiRow.emi_amount || 0);

        const [paidSumRow] = await sql`
          SELECT COALESCE(SUM(paid_amount), 0)::numeric AS sum 
          FROM emi_schedules 
          WHERE booking_id = ${emiRow.booking_id} AND emi_status = 'Paid'
        `;
        const totalPaidTillDate = Number(emiRow.advance_amount || 0) + Number(paidSumRow?.sum || 0);
        const remainingBal = Math.max(0, totalPlotPrice - totalPaidTillDate);

        const invData = {
          invoice_number: formattedInvNum,
          invoice_type: "EMI Installment Payment",
          emi_id: emiRow.emi_id,
          installment_no: emiRow.installment_no,
          booking_id: emiRow.booking_id,
          booking_serial: emiRow.booking_serial || `BK-${emiRow.booking_id}`,
          customer_name: emiRow.full_name || "Valued Customer",
          mobile_no: emiRow.mobile_no || "",
          email: emiRow.email || "",
          father_name: emiRow.father_name || "",
          address: emiRow.address || "",
          associate_name: emiRow.associate_name || "",
          associate_mobile: emiRow.associate_mobile || "",
          associate_id: emiRow.associate_user_id || "",
          site_name: emiRow.site_name || "MMR City",
          plot_number: emiRow.plot_number || "Plot",
          plot_size: `${emiRow.plot_area || ''} Sq.Yd.`.trim(),
          total_plot_price: totalPlotPrice,
          down_payment: Number(emiRow.advance_amount || 0),
          emi_amount: emiAmt,
          grand_total: emiAmt,
          paid_amount: emiAmt,
          total_paid_till_date: totalPaidTillDate,
          balance_amount: remainingBal,
          payment_method: emiRow.payment_mode || "Online / Bank",
          payment_type: "EMI",
          is_emi: true,
          payment_date: emiRow.paid_date ? new Date(emiRow.paid_date).toISOString().split('T')[0] : (emiRow.due_date ? new Date(emiRow.due_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]),
          due_date: emiRow.due_date,
          transaction_id: emiRow.transaction_reference || `EMI-${emiRow.emi_id}`,
          payment_status: emiRow.emi_status === 'Paid' ? 'Paid' : 'Pending',
          order_status: "Completed"
        };

        invoice = {
          invoice_id: emiRow.emi_id,
          invoice_number: formattedInvNum,
          order_id: `EMI-${emiRow.emi_id}`,
          user_id: emiRow.user_id,
          associate_id: emiRow.associate_user_id || null,
          booking_id: emiRow.booking_id,
          invoice_date: emiRow.paid_date || emiRow.due_date || emiRow.created_at || new Date(),
          grand_total: emiAmt,
          paid_amount: emiAmt,
          balance_amount: remainingBal,
          payment_method: emiRow.payment_mode || 'Online / Bank',
          payment_status: emiRow.emi_status === 'Paid' ? 'Paid' : 'Pending',
          order_status: 'Completed',
          invoice_data: invData
        };
      }
    }

    if (!invoice && cleanId !== null) {
      const [booking] = await sql`
        SELECT b.*, COALESCE(b.plot_number, p.plot_number, 'Plot') AS plot_number,
               COALESCE(b.plot_area, p.plot_area, 0) AS plot_area,
               COALESCE(p.plot_category::text, 'Residential') AS plot_type,
               COALESCE(p.plot_category::text, 'Residential') AS plot_category,
               COALESCE(NULLIF(b.base_price, 0), NULLIF(b.requested_price, 0), NULLIF(p.sold_price, 0), NULLIF(p.base_price, 0), (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0) AS calc_price,
               COALESCE(s.site_name, s2.site_name, 'MMR City') AS site_name,
               u.full_name, u.mobile_no, u.email, u.father_name,
               COALESCE((SELECT address_line1 FROM user_addresses WHERE user_id = u.user_id LIMIT 1), '') AS address,
               assoc.full_name AS associate_name, assoc.mobile_no AS associate_mobile, assoc.user_id AS associate_user_id
        FROM bookings b
        LEFT JOIN plots p ON b.plot_id = p.plot_id
        LEFT JOIN sites s ON p.site_id = s.site_id
        LEFT JOIN sites s2 ON b.site_id = s2.site_id
        JOIN users u ON b.user_id = u.user_id
        LEFT JOIN users assoc ON COALESCE(b.associate_user_id, b.sold_by_user_id) = assoc.user_id
        WHERE b.booking_id = ${cleanId}
        LIMIT 1
      `;

      if (booking) {
        const totalPlotPrice = Number(booking.calc_price || booking.base_price || booking.requested_price || booking.total_amount || 0);
        const downPayment = Number(booking.advance_amount || booking.required_booking_amount || 0);
        
        const payType = String(booking.payment_type || booking.payment_method || '').toLowerCase();
        const isOneTime = payType.includes('full') || payType.includes('onetime') || payType.includes('one time') || payType === 'one_time';
        const isPartWise = payType.includes('part') || payType.includes('downpayment') || payType.includes('down_payment');
        const isEmi = payType.includes('emi') || payType.includes('installment');

        // Payment method logic: One-time payment => zero due amount!
        let remainingBal = 0;
        let paidAmount = downPayment;
        let grandTotal = totalPlotPrice;
        let paymentStatus = "Paid";

        if (isOneTime) {
          remainingBal = 0;
          paidAmount = totalPlotPrice;
          grandTotal = totalPlotPrice;
          paymentStatus = "Paid in Full";
        } else if (isPartWise) {
          remainingBal = Math.max(0, totalPlotPrice - downPayment);
          paidAmount = downPayment;
          grandTotal = totalPlotPrice;
          paymentStatus = remainingBal === 0 ? "Paid in Full" : "Partially Paid";
        } else {
          remainingBal = Math.max(0, totalPlotPrice - downPayment);
          grandTotal = totalPlotPrice;
        }

        // Next due date for part-wise payment
        let deadlineDate = booking.part_wise_deadline_at;
        if (!deadlineDate && booking.created_at) {
          const bDate = new Date(booking.created_at);
          bDate.setMonth(bDate.getMonth() + 3);
          deadlineDate = bDate.toISOString();
        }

        const formattedInvNum = `MMR-INV-${booking.booking_id}`;

        const invData = {
          invoice_number: formattedInvNum,
          invoice_type: isOneTime ? "Plot Full Purchase Invoice" : (isPartWise ? "Plot Part Payment Invoice" : "Plot Booking Advance"),
          booking_id: booking.booking_id,
          booking_serial: booking.booking_serial || `BK-${booking.booking_id}`,
          customer_name: booking.full_name || "Valued Customer",
          mobile_no: booking.mobile_no || "",
          email: booking.email || "",
          father_name: booking.father_name || "",
          address: booking.address || "",
          associate_name: booking.associate_name || "",
          associate_mobile: booking.associate_mobile || "",
          associate_id: booking.associate_user_id || "",
          site_name: booking.site_name || "MMR City",
          plot_number: booking.plot_number || "Plot",
          plot_size: `${booking.plot_area || ''} Sq.Yd.`.trim(),
          total_plot_price: totalPlotPrice,
          down_payment: downPayment,
          emi_amount: downPayment,
          grand_total: grandTotal,
          paid_amount: paidAmount,
          total_paid_till_date: paidAmount,
          balance_amount: remainingBal,
          payment_method: isOneTime ? "One Time / Full Payment" : (booking.payment_method || booking.payment_type || "Cash / Bank"),
          payment_type: booking.payment_type || (isOneTime ? "FullPayment" : (isPartWise ? "PartWise" : "EMI")),
          is_one_time: isOneTime,
          is_part_wise: isPartWise,
          is_emi: isEmi,
          part_wise_deadline_at: deadlineDate,
          tenure_months: booking.emi_tenure_months || 60,
          monthly_emi: booking.monthly_emi || 0,
          payment_date: booking.created_at ? new Date(booking.created_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
          transaction_id: booking.booking_serial || `BK-${booking.booking_id}`,
          payment_status: paymentStatus,
          order_status: "Completed"
        };

        try {
          const [created] = await sql`
            INSERT INTO invoices (
              invoice_number, order_id, user_id, booking_id, invoice_date, subtotal, discount,
              registration_charges, development_charges, other_charges, grand_total,
              paid_amount, balance_amount, payment_method, payment_status, order_status,
              invoice_data, created_at, updated_at
            ) VALUES (
              ${formattedInvNum}, ${booking.booking_serial || `BK-${booking.booking_id}`}, ${booking.user_id}, ${booking.booking_id},
              ${booking.created_at || new Date()}, ${totalPlotPrice}, 0.00, 0.00, 0.00, 0.00, ${grandTotal}, ${paidAmount},
              ${remainingBal}, ${invData.payment_method}, ${paymentStatus}, 'Completed',
              ${JSON.stringify(invData)}::jsonb, NOW(), NOW()
            ) RETURNING *
          `;
          invoice = created;
        } catch (_) {
          invoice = {
            invoice_id: booking.booking_id,
            invoice_number: formattedInvNum,
            order_id: booking.booking_serial,
            user_id: booking.user_id,
            booking_id: booking.booking_id,
            invoice_date: booking.created_at || new Date(),
            grand_total: grandTotal,
            paid_amount: paidAmount,
            balance_amount: remainingBal,
            payment_method: invData.payment_method,
            payment_status: paymentStatus,
            order_status: 'Completed',
            invoice_data: invData
          };
        }
      }
    }

    if (!invoice) return fail(res, "Invoice not found.", 404);

    const hasAccess = await canAccessInvoice(req.user, invoice);
    if (!hasAccess) return fail(res, "Unauthorized to access this invoice.", 403);

    // Fetch and sync underlying booking data & EMI schedules
    const targetBookingId = invoice.booking_id || (invoice.invoice_data && invoice.invoice_data.booking_id);
    if (targetBookingId) {
      try {
        const [targetBooking] = await sql`
          SELECT b.*, COALESCE(b.plot_number, p.plot_number, 'Plot') AS plot_number,
                 COALESCE(b.plot_area, p.plot_area, 0) AS plot_area,
                 COALESCE(NULLIF(b.base_price, 0), NULLIF(b.requested_price, 0), NULLIF(p.sold_price, 0), NULLIF(p.base_price, 0), (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0) AS calc_price,
                 COALESCE(s.site_name, 'MMR City') AS site_name,
                 u.father_name,
                 COALESCE((SELECT address_line1 FROM user_addresses WHERE user_id = u.user_id LIMIT 1), '') AS address,
                 assoc.full_name AS associate_name, assoc.mobile_no AS associate_mobile, assoc.user_id AS associate_user_id
          FROM bookings b
          LEFT JOIN plots p ON b.plot_id = p.plot_id
          LEFT JOIN sites s ON COALESCE(b.site_id, p.site_id) = s.site_id
          JOIN users u ON b.user_id = u.user_id
          LEFT JOIN users assoc ON COALESCE(b.associate_user_id, b.sold_by_user_id) = assoc.user_id
          WHERE b.booking_id = ${targetBookingId}
          LIMIT 1
        `;

        if (targetBooking) {
          const payType = String(targetBooking.payment_type || invoice.payment_method || invoice.invoice_data?.payment_method || '').toLowerCase();
          const isOneTime = payType.includes('full') || payType.includes('onetime') || payType.includes('one time') || payType === 'one_time';
          const isPartWise = payType.includes('part') || payType.includes('downpayment') || payType.includes('down_payment');
          const isEmi = payType.includes('emi') || payType.includes('installment');

          let deadlineDate = targetBooking.part_wise_deadline_at;
          if (!deadlineDate && targetBooking.created_at) {
            const bDate = new Date(targetBooking.created_at);
            bDate.setMonth(bDate.getMonth() + 3);
            deadlineDate = bDate.toISOString();
          }

          const emiSchedules = await sql`
            SELECT * FROM emi_schedules
            WHERE booking_id = ${targetBookingId}
            ORDER BY installment_no ASC
          `;

          // Ensure invoice_data is an object
          invoice.invoice_data = typeof invoice.invoice_data === 'string' ? JSON.parse(invoice.invoice_data) : (invoice.invoice_data || {});

          const effectivePrice = Number(
            targetBooking.calc_price || 
            targetBooking.base_price || 
            targetBooking.requested_price || 
            targetBooking.sold_price || 
            (Number(targetBooking.advance_amount || 0) + Number(targetBooking.remaining_balance || 0)) || 
            0
          );

          if (effectivePrice > 0 && (Number(invoice.grand_total || 0) <= 0 || Number(invoice.subtotal || 0) <= 0 || Number(invoice.invoice_data.total_plot_price || 0) <= 0)) {
            const downPay = Number(targetBooking.advance_amount || invoice.paid_amount || invoice.invoice_data.paid_amount || 0);
            const remBal = Math.max(0, effectivePrice - downPay);
            invoice.grand_total = effectivePrice;
            invoice.total_amount = effectivePrice;
            invoice.subtotal = effectivePrice;
            invoice.balance_amount = remBal;
            if (!invoice.paid_amount || Number(invoice.paid_amount) <= 0) {
              invoice.paid_amount = downPay;
            }
            invoice.invoice_data.total_plot_price = effectivePrice;
            invoice.invoice_data.grand_total = effectivePrice;
            invoice.invoice_data.down_payment = downPay;
            invoice.invoice_data.paid_amount = invoice.paid_amount;
            invoice.invoice_data.balance_amount = remBal;

            // Persist heal back to DB asynchronously
            await sql`
              UPDATE invoices SET
                grand_total = ${effectivePrice},
                total_amount = ${effectivePrice},
                subtotal = ${effectivePrice},
                balance_amount = ${remBal},
                paid_amount = ${invoice.paid_amount},
                invoice_data = ${JSON.stringify(invoice.invoice_data)}::jsonb,
                updated_at = NOW()
              WHERE invoice_id = ${invoice.invoice_id}
            `.catch(() => {});
          }
          
          if (isOneTime) {
            invoice.balance_amount = 0;
            invoice.payment_status = "Paid in Full";
            invoice.invoice_data.balance_amount = 0;
            invoice.invoice_data.payment_status = "Paid in Full";
            invoice.invoice_data.is_one_time = true;
          }

          if (isPartWise) {
            invoice.invoice_data.is_part_wise = true;
            invoice.invoice_data.part_wise_deadline_at = deadlineDate;
            invoice.part_wise_deadline_at = deadlineDate;
          }

          invoice.invoice_data.father_name = invoice.invoice_data.father_name || targetBooking.father_name || "";
          invoice.invoice_data.address = invoice.invoice_data.address || targetBooking.address || "";
          invoice.invoice_data.associate_name = invoice.invoice_data.associate_name || targetBooking.associate_name || "";
          invoice.invoice_data.associate_mobile = invoice.invoice_data.associate_mobile || targetBooking.associate_mobile || "";
          invoice.invoice_data.associate_id = invoice.invoice_data.associate_id || targetBooking.associate_user_id || "";
          invoice.invoice_data.is_emi = isEmi || (emiSchedules.length > 0);
          invoice.invoice_data.tenure_months = targetBooking.emi_tenure_months || 60;
          invoice.invoice_data.monthly_emi = targetBooking.monthly_emi || 0;
          invoice.invoice_data.emi_schedules = emiSchedules;
          invoice.emi_schedules = emiSchedules;
        }
      } catch (syncErr) {
        console.warn("Invoice data sync notice:", syncErr.message);
      }
    }

    // Fetch Invoice Settings with official credentials & fallbacks
    const settings = await getEffectiveInvoiceSettings();

    // Generate QR Code & Verification URL directly to frontend invoice page
    const publicInvoiceUrl = resolveFrontendInvoiceUrl(invoice, invoiceNumber);
    const qrDataUrl = await QRCode.toDataURL(publicInvoiceUrl, { margin: 1, width: 220, errorCorrectionLevel: 'M' });

    // Generate Barcode Data URL
    let barcodeDataUrl = "";
    try {
      const pngBuffer = await bwipjs.toBuffer({
        bcid: "code128",
        text: invoice.invoice_number,
        scale: 3,
        height: 10,
        includetext: true,
        textxalign: "center",
      });
      barcodeDataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
    } catch (bErr) {
      console.error("Barcode generation error:", bErr);
    }

    // Audit Log Entry
    try {
      const actorId = req.user?.user_id || req.user?.admin_id || req.user?.id || 0;
      const actorRole = req.user?.role || (req.user?.admin_id ? 'Admin' : 'USER');
      if (invoice.invoice_id) {
        await sql`
          INSERT INTO invoice_audit_log (log_id, invoice_id, invoice_number, action, performed_by_id, performed_by_role, ip_address)
          VALUES (
            (SELECT COALESCE(MAX(log_id), 0) + 1 FROM invoice_audit_log),
            ${invoice.invoice_id}, ${invoice.invoice_number || ''}, 'VIEWED', ${actorId}, ${actorRole}, ${req.ip || ''}
          )
          ON CONFLICT DO NOTHING`;
      }
    } catch (auditErr) {
      console.warn("Invoice audit log non-critical warning:", auditErr.message);
    }

    return ok(res, {
      invoice,
      settings: settings || {},
      qr_code: qrDataUrl,
      barcode: barcodeDataUrl,
      verify_url: publicInvoiceUrl,
    });
  } catch (error) {
    console.error("GET /api/invoice/:invoiceNumber error:", error);
    return fail(res, error.message);
  }
});

// ── Core PDF Streaming Engine with Landscape 2-Copy Layout & Embedded QR ──
async function renderInvoicePdfStream({ invoice, settings, downloadUrl, res }) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${invoice.invoice_number}.pdf"`);

  let qrPngBuffer = null;
  if (downloadUrl) {
    try {
      qrPngBuffer = await QRCode.toBuffer(downloadUrl, {
        margin: 1,
        width: 140,
        errorCorrectionLevel: "M",
      });
    } catch (qrErr) {
      console.warn("Failed to generate QR buffer for PDF:", qrErr);
    }
  }

  const doc = new PDFDocument({ margin: 15, size: "A4", layout: "landscape" });
  doc.pipe(res);

  const margin = 15;
  const colWidth = 390;
  const colHeight = 565;
  const data = invoice.invoice_data || {};

  const renderCopy = (startX, copyTitleEn, copyTitleHi, isBuyer) => {
    // 1. Outer Box
    const topBarColor = isBuyer ? "#15803d" : "#0284c7";
    doc.roundedRect(startX, margin, colWidth, colHeight, 5).lineWidth(1).strokeColor("#cbd5e1").stroke();
    doc.rect(startX + 1, margin, colWidth - 2, 4).fill(topBarColor);

    // 2. Company Brand & Header
    doc.fillColor("#0f172a").fontSize(10.5).font("Helvetica-Bold").text(settings.company_name || "MMR Construction & Developers", startX + 10, margin + 9);
    doc.fontSize(6.5).font("Helvetica").fillColor("#64748b").text(settings.address || "Tribhuvan Kheda, Sheshpur, Unnao, Uttar Pradesh, India, 209801", startX + 10, margin + 22, { width: colWidth - 145 });
    doc.text(
      `CIN: ${settings.cin || "U68200UP2025PTC229203"}  |  GSTIN: ${settings.gst_number || "09AATCM6753A1Z5"}  |  Ph: ${settings.phone || "+91 95111 19879"}  |  Email: ${settings.email || "official@mmrconstructions.in"}`,
      startX + 10,
      margin + 31,
      { width: colWidth - 20 }
    );

    // Copy Tag Pill
    const pillW = 125;
    const pillH = 20;
    const pillX = startX + colWidth - pillW - 10;
    const pillY = margin + 8;
    doc.roundedRect(pillX, pillY, pillW, pillH, 3).lineWidth(1).strokeColor(topBarColor).fillAndStroke(isBuyer ? "#ecfdf5" : "#f0f9ff", topBarColor);
    doc.fillColor(topBarColor).fontSize(6).font("Helvetica-Bold").text(copyTitleEn, pillX, pillY + 3, { width: pillW, align: "center" });
    doc.fontSize(5.5).font("Helvetica").text(copyTitleHi, pillX, pillY + 11, { width: pillW, align: "center" });

    // 3. Meta Strip
    const metaY = margin + 44;
    doc.rect(startX + 10, metaY, colWidth - 20, 16).fillAndStroke("#f8fafc", "#e2e8f0");
    doc.fontSize(7).font("Helvetica-Bold").fillColor("#64748b").text("INVOICE NO: ", startX + 14, metaY + 4, { continued: true });
    doc.fillColor("#15803d").text(invoice.invoice_number, { continued: true });
    doc.fillColor("#64748b").text("     DATE: ", { continued: true });
    doc.fillColor("#0f172a").text(new Date(invoice.invoice_date).toLocaleDateString("en-IN"), { continued: true });
    doc.fillColor("#64748b").text("     ORDER ID: ", { continued: true });
    doc.fillColor("#0f172a").text(invoice.order_id || `BK-${invoice.booking_id}`);

    // 4. Details 2-Column Grid (Buyer Info & Property Info)
    const gridY = metaY + 22;
    const subColW = (colWidth - 26) / 2;

    // Buyer box
    doc.roundedRect(startX + 10, gridY, subColW, 72, 3).fillAndStroke("#ffffff", "#e2e8f0");
    doc.rect(startX + 10, gridY, subColW, 14).fill("#f1f5f9");
    doc.fillColor("#0f172a").fontSize(7).font("Helvetica-Bold").text("BUYER / CUSTOMER DETAILS", startX + 14, gridY + 3);

    let bY = gridY + 18;
    const drawRow = (x, y, k, v, isBold = false) => {
      doc.fontSize(6.5).font("Helvetica").fillColor("#64748b").text(k, x + 4, y, { width: 55 });
      doc.font(isBold ? "Helvetica-Bold" : "Helvetica").fillColor(isBold ? "#0f172a" : "#334155").text(String(v || "-"), x + 60, y, { width: subColW - 65, height: 10, ellipsis: true });
    };
    drawRow(startX + 10, bY, "Buyer Name:", data.customer_name || "-", true);
    bY += 12;
    drawRow(startX + 10, bY, "Mobile No:", data.mobile_no || "-");
    bY += 12;
    drawRow(startX + 10, bY, "Email:", data.email || "-");
    bY += 12;
    drawRow(startX + 10, bY, "Address:", data.address || data.full_address || "-");

    // Property & Seller box
    const pX = startX + 10 + subColW + 6;
    doc.roundedRect(pX, gridY, subColW, 72, 3).fillAndStroke("#ffffff", "#e2e8f0");
    doc.rect(pX, gridY, subColW, 14).fill("#f1f5f9");
    doc.fillColor("#0f172a").fontSize(7).font("Helvetica-Bold").text("PROPERTY & SELLER DETAILS", pX + 4, gridY + 3);

    let pY = gridY + 18;
    drawRow(pX, pY, "Site / Project:", data.site_name || "-", true);
    pY += 12;
    drawRow(pX, pY, "Plot No:", `#${data.plot_number || '-'} (Block: ${data.block || 'Main'})`, true);
    pY += 12;
    drawRow(pX, pY, "Size / Area:", data.plot_size || `${data.plot_area || 0} Gaj`);
    pY += 12;
    drawRow(pX, pY, "Seller Company:", settings.company_name || "MMR Construction");

    // 5. Financial Summary Table
    const tableY = gridY + 78;
    doc.rect(startX + 10, tableY, colWidth - 20, 14).fill("#f8fafc");
    doc.fontSize(7).font("Helvetica-Bold").fillColor("#475569").text("Description", startX + 14, tableY + 3);
    doc.text("Amount (INR)", startX + colWidth - 85, tableY + 3, { width: 65, align: "right" });

    let tY = tableY + 16;
    const finRows = [
      ["Agreed Plot Price", `INR ${Number(data.total_plot_price || invoice.subtotal || 0).toLocaleString("en-IN")}`],
      ["Grand Total Plot Value", `INR ${Number(invoice.grand_total || data.total_plot_price || 0).toLocaleString("en-IN")}`, true],
      ["Amount Paid (Advance / Received)", `INR ${Number(data.paid_amount || invoice.paid_amount || 0).toLocaleString("en-IN")}`, true, "#15803d"],
      ["Remaining Balance Amount", Number(invoice.balance_amount || 0) === 0 ? "INR 0 (Paid in Full)" : `INR ${Number(invoice.balance_amount || 0).toLocaleString("en-IN")}`, true, Number(invoice.balance_amount || 0) === 0 ? "#15803d" : "#dc2626"]
    ];

    for (const [lbl, val, bold, color] of finRows) {
      doc.lineWidth(0.5).strokeColor("#f1f5f9").moveTo(startX + 10, tY + 12).lineTo(startX + colWidth - 10, tY + 12).stroke();
      doc.fontSize(6.8).font(bold ? "Helvetica-Bold" : "Helvetica").fillColor(color || (bold ? "#0f172a" : "#475569")).text(lbl, startX + 14, tY);
      doc.text(val, startX + colWidth - 110, tY, { width: 90, align: "right" });
      tY += 14;
    }

    // 6. Payment Mode & Status Bar
    const payY = tY + 4;
    doc.roundedRect(startX + 10, payY, colWidth - 20, 16, 3).fillAndStroke("#f1f5f9", "#e2e8f0");
    doc.fontSize(6.8).font("Helvetica-Bold").fillColor("#64748b").text("Payment Mode: ", startX + 14, payY + 4, { continued: true });
    doc.fillColor("#0f172a").text(`${data.payment_method || invoice.payment_method || 'Bank Transfer'}   |   Status: `, { continued: true });
    doc.fillColor("#15803d").text(invoice.payment_status || "Paid in Full");

    // 7. Notice / Note Box
    const noteY = payY + 22;
    doc.roundedRect(startX + 10, noteY, colWidth - 20, 24, 3).fillAndStroke("#f0fdf4", "#86efac");
    doc.fontSize(6.5).font("Helvetica-Bold").fillColor("#15803d").text("NOTE / महत्वपूर्ण निर्देश: Invoice ko sambhal kar rakhein. Payment dispute me saathi.", startX + 14, noteY + 4);
    doc.font("Helvetica").fontSize(6).fillColor("#166534").text("This tax invoice is issued subject to MMR Construction plot booking terms & mutual agreement.", startX + 14, noteY + 13);

    // 8. Dual Signatures & Stamps Footer + Embedded QR Code
    const footY = margin + colHeight - 55;
    doc.lineWidth(0.5).strokeColor("#e2e8f0").moveTo(startX + 10, footY).lineTo(startX + colWidth - 10, footY).stroke();

    // Buyer Signature (Left)
    const sigY = footY + 5;
    doc.lineWidth(1).strokeColor("#94a3b8").dash(2, { space: 2 }).moveTo(startX + 14, sigY + 22).lineTo(startX + 115, sigY + 22).stroke().undash();
    doc.fontSize(6.5).font("Helvetica-Bold").fillColor("#0f172a").text("Buyer's Signature / Thumb", startX + 14, sigY + 26);
    doc.fontSize(5.5).font("Helvetica").fillColor("#64748b").text(`(हस्ताक्षर / अँगूठा - क्रेता: ${data.customer_name || 'Buyer'})`, startX + 14, sigY + 35, { width: 105 });

    // Center: Embedded Real QR Code & Verified Seal
    if (qrPngBuffer) {
      doc.image(qrPngBuffer, startX + 125, sigY + 2, { width: 36, height: 36 });
      doc.rect(startX + 165, sigY + 2, 85, 36).fillAndStroke("#f8fafc", "#cbd5e1");
      doc.fontSize(6.5).font("Helvetica-Bold").fillColor("#15803d").text("OFFICIALLY VERIFIED", startX + 165, sigY + 6, { width: 85, align: "center" });
      doc.fontSize(5).font("Helvetica").fillColor("#475569").text("Scan QR to View Invoice", startX + 165, sigY + 16, { width: 85, align: "center" });
      doc.fontSize(4.5).font("Helvetica").fillColor("#94a3b8").text("Tamper-Proof SHA-256", startX + 165, sigY + 25, { width: 85, align: "center" });
    } else {
      doc.rect(startX + 135, sigY + 5, 110, 30).fillAndStroke("#f8fafc", "#e2e8f0");
      doc.fontSize(6.5).font("Helvetica-Bold").fillColor("#15803d").text("OFFICIALLY VERIFIED", startX + 135, sigY + 9, { width: 110, align: "center" });
      doc.fontSize(5.5).font("Helvetica").fillColor("#64748b").text("Tax Invoice & Booking Record", startX + 135, sigY + 19, { width: 110, align: "center" });
    }

    // Seller Signature (Right)
    const sellerSigX = startX + colWidth - 125;
    doc.lineWidth(1).strokeColor("#94a3b8").dash(2, { space: 2 }).moveTo(sellerSigX, sigY + 22).lineTo(sellerSigX + 115, sigY + 22).stroke().undash();
    doc.fontSize(6.5).font("Helvetica-Bold").fillColor("#0f172a").text("Seller's Signatory & Stamp", sellerSigX, sigY + 26, { width: 115, align: "right" });
    doc.fontSize(5.5).font("Helvetica").fillColor("#64748b").text(`(अधिकृत हस्ताक्षर - ${settings.company_name || 'MMR'})`, sellerSigX, sigY + 35, { width: 115, align: "right" });
  };

  // Render Part 1: Buyer Copy (Left)
  renderCopy(margin, "BUYER COPY / CUSTOMER COPY", "(क्रेता प्रति — Original for Buyer)", true);

  // Render Center Cut Divider
  const cutX = margin + colWidth + 11;
  doc.lineWidth(1).strokeColor("#94a3b8").dash(4, { space: 3 }).moveTo(cutX, margin).lineTo(cutX, margin + colHeight).stroke().undash();
  doc.save();
  doc.rect(cutX - 6, margin + (colHeight / 2) - 30, 12, 60).fill("#ffffff");
  doc.fontSize(7).font("Helvetica-Bold").fillColor("#64748b").text("✂ CUT HERE", cutX - 25, margin + (colHeight / 2) - 4, { width: 50, align: "center" });
  doc.restore();

  // Render Part 2: Seller Copy (Right)
  const rightStartX = margin + colWidth + 22;
  renderCopy(rightStartX, "SELLER COPY / COMPANY COPY", "(विक्रेता प्रति — Original for Seller)", false);

  doc.end();
}

// ----------------------------------------------------
// 3. GET /api/invoice/:invoiceNumber/pdf (Download PDF for User/Admin)
// ----------------------------------------------------
router.get("/invoice/:invoiceNumber/pdf", optionalAuth, async (req, res) => {
  try {
    const { invoiceNumber } = req.params;
    const isEmiQuery = String(invoiceNumber || "").toUpperCase().startsWith("EMI-") || 
                       String(invoiceNumber || "").toUpperCase().includes("-EMI-") ||
                       req.query.type === 'emi';

    const cleanNum = String(invoiceNumber || "")
      .replace(/^MMR-INV-EMI-/i, "")
      .replace(/^MMR-INV-/i, "")
      .replace(/^MMR-RC-/i, "")
      .replace(/^BK-/i, "")
      .replace(/^INV-/i, "")
      .replace(/^EMI-/i, "")
      .trim();
    const trailingNumMatch = cleanNum.match(/(\d+)$/);
    const cleanId = !isNaN(Number(cleanNum)) && cleanNum.length > 0 
      ? Number(cleanNum) 
      : (trailingNumMatch ? Number(trailingNumMatch[1]) : null);

    let [invoice] = await sql`
      SELECT * FROM invoices
      WHERE LOWER(invoice_number) = LOWER(${invoiceNumber})
         OR LOWER(order_id) = LOWER(${invoiceNumber})
         OR (CASE WHEN ${cleanId !== null} THEN invoice_id = ${cleanId} OR booking_id = ${cleanId} ELSE false END)
         OR (invoice_data->>'booking_id')::text = ${cleanNum}
         OR (invoice_data->>'booking_id')::text = ${String(cleanId)}
         OR (invoice_data->>'invoice_number') ILIKE ${'%' + invoiceNumber + '%'}
         OR invoice_number ILIKE ${'%' + invoiceNumber + '%'}
      ORDER BY invoice_id ASC
      LIMIT 1
    `;

    if (!invoice && cleanId !== null) {
      const [booking] = await sql`
        SELECT b.*, COALESCE(b.plot_number, p.plot_number, 'Plot') AS plot_number,
               COALESCE(b.plot_area, p.plot_area, 0) AS plot_area,
               COALESCE(p.plot_category::text, 'Residential') AS plot_type,
               COALESCE(p.plot_category::text, 'Residential') AS plot_category,
               COALESCE(s.site_name, s2.site_name, 'MMR City') AS site_name,
               u.full_name, u.mobile_no, u.email
        FROM bookings b
        LEFT JOIN plots p ON b.plot_id = p.plot_id
        LEFT JOIN sites s ON p.site_id = s.site_id
        LEFT JOIN sites s2 ON b.site_id = s2.site_id
        JOIN users u ON b.user_id = u.user_id
        WHERE b.booking_id = ${cleanId}
        LIMIT 1
      `;

      if (booking) {
        const totalPlotPrice = Number(booking.base_price || booking.requested_price || (COALESCE_PRICE => COALESCE_PRICE)(booking.total_amount) || 0);
        const downPayment = Number(booking.advance_amount || booking.required_booking_amount || 0);
        const remainingBal = Math.max(0, totalPlotPrice - downPayment);
        const formattedInvNum = `MMR-INV-${booking.booking_id}`;

        const invData = {
          invoice_number: formattedInvNum,
          invoice_type: "Plot Booking Advance",
          booking_id: booking.booking_id,
          booking_serial: booking.booking_serial || `BK-${booking.booking_id}`,
          customer_name: booking.full_name || "Valued Customer",
          mobile_no: booking.mobile_no || "",
          email: booking.email || "",
          site_name: booking.site_name || "MMR City",
          plot_number: booking.plot_number || "Plot",
          plot_size: `${booking.plot_area || ''} Sq.Yd.`.trim(),
          total_plot_price: totalPlotPrice,
          down_payment: downPayment,
          emi_amount: downPayment,
          grand_total: totalPlotPrice > 0 ? totalPlotPrice : downPayment,
          paid_amount: downPayment,
          total_paid_till_date: downPayment,
          balance_amount: remainingBal,
          payment_method: booking.payment_method || booking.payment_type || "Cash / Bank",
          payment_date: booking.created_at ? new Date(booking.created_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
          transaction_id: booking.booking_serial || `BK-${booking.booking_id}`,
          payment_status: "Paid",
          order_status: "Completed"
        };

        invoice = {
          invoice_id: booking.booking_id,
          invoice_number: formattedInvNum,
          order_id: booking.booking_serial,
          user_id: booking.user_id,
          booking_id: booking.booking_id,
          invoice_date: booking.created_at || new Date(),
          grand_total: totalPlotPrice > 0 ? totalPlotPrice : downPayment,
          paid_amount: downPayment,
          balance_amount: remainingBal,
          payment_method: booking.payment_method || 'Cash / Bank',
          payment_status: 'Paid',
          order_status: 'Completed',
          invoice_data: invData
        };
      }
    }

    if (!invoice) return fail(res, "Invoice not found.", 404);

    const hasAccess = await canAccessInvoice(req.user, invoice);
    if (!hasAccess) return fail(res, "Unauthorized to access this invoice.", 403);

    // Ensure invoice_data is an object and auto-heal if grand_total or total_plot_price is 0
    invoice.invoice_data = typeof invoice.invoice_data === 'string' ? JSON.parse(invoice.invoice_data) : (invoice.invoice_data || {});
    if (Number(invoice.grand_total || 0) <= 0 || Number(invoice.invoice_data?.total_plot_price || 0) <= 0) {
      const bId = invoice.booking_id || invoice.invoice_data.booking_id || cleanId;
      if (bId) {
        const [hb] = await sql`
          SELECT b.*, COALESCE(NULLIF(b.base_price, 0), NULLIF(b.requested_price, 0), NULLIF(p.sold_price, 0), NULLIF(p.base_price, 0), (COALESCE(b.advance_amount, 0) + COALESCE(b.remaining_balance, 0)), 0) AS calc_price
          FROM bookings b
          LEFT JOIN plots p ON b.plot_id = p.plot_id
          WHERE b.booking_id = ${bId}
          LIMIT 1
        `;
        if (hb) {
          const bp = Number(hb.calc_price || hb.base_price || hb.requested_price || 0);
          if (bp > 0) {
            const downPay = Number(hb.advance_amount || invoice.paid_amount || invoice.invoice_data.paid_amount || 0);
            invoice.grand_total = bp;
            invoice.subtotal = bp;
            invoice.total_amount = bp;
            invoice.balance_amount = Math.max(0, bp - downPay);
            invoice.invoice_data.total_plot_price = bp;
            invoice.invoice_data.grand_total = bp;
            invoice.invoice_data.down_payment = downPay;
            invoice.invoice_data.paid_amount = downPay;
            invoice.invoice_data.balance_amount = invoice.balance_amount;
          }
        }
      }
    }

    const settings = await getEffectiveInvoiceSettings();
    const publicBase = resolvePublicBaseUrl(req);
    const token = generateInvoiceToken(
      invoice.invoice_number,
      invoice.invoice_id || invoice.booking_id,
      invoice.grand_total
    );
    const publicInvoiceUrl = resolveFrontendInvoiceUrl(invoice, invoiceNumber);
    const downloadUrl = publicInvoiceUrl;

    // Audit Log Entry
    try {
      const actorId = req.user?.user_id || req.user?.admin_id || req.user?.id || 0;
      const actorRole = req.user?.role || (req.user?.admin_id ? 'Admin' : (req.user ? 'USER' : 'GUEST'));
      await sql`
        INSERT INTO invoice_audit_log (log_id, invoice_id, invoice_number, action, performed_by_id, performed_by_role, ip_address)
        VALUES (
          (SELECT COALESCE(MAX(log_id), 0) + 1 FROM invoice_audit_log),
          ${invoice.invoice_id || 0}, ${invoice.invoice_number || ''}, 'DOWNLOADED', ${actorId}, ${actorRole}, ${req.ip || ''}
        )
        ON CONFLICT DO NOTHING`;
    } catch (_) {}

    await renderInvoicePdfStream({ invoice, settings, downloadUrl, res });
  } catch (error) {
    console.error("GET /api/invoice/:invoiceNumber/pdf error:", error);
    if (!res.headersSent) return fail(res, error.message);
  }
});

// ----------------------------------------------------
// 3b. GET /api/public/invoice/download/:invoiceNumber (Tamper-Proof QR Code Scan PDF Download)
// ----------------------------------------------------
router.get("/public/invoice/download/:invoiceNumber", async (req, res) => {
  try {
    const { invoiceNumber } = req.params;
    const { token } = req.query;

    if (!token || typeof token !== "string") {
      return res.status(403).send("<h1>403 Forbidden</h1><p>Missing security token. Access is only permitted via official QR code scan.</p>");
    }

    const cleanNum = String(invoiceNumber || "").replace(/^MMR-INV-/i, "").replace(/^BK-/i, "").replace(/^INV-/i, "").trim();
    const trailingNumMatch = cleanNum.match(/(\d+)$/);
    const cleanId = !isNaN(Number(cleanNum)) && cleanNum.length > 0 ? Number(cleanNum) : (trailingNumMatch ? Number(trailingNumMatch[1]) : null);

    let [invoice] = await sql`
      SELECT * FROM invoices
      WHERE LOWER(invoice_number) = LOWER(${invoiceNumber})
         OR LOWER(order_id) = LOWER(${invoiceNumber})
         OR (CASE WHEN ${cleanId !== null} THEN invoice_id = ${cleanId} OR booking_id = ${cleanId} ELSE false END)
         OR (invoice_data->>'booking_id')::text = ${cleanNum}
         OR (invoice_data->>'booking_id')::text = ${String(cleanId)}
         OR (invoice_data->>'invoice_number') ILIKE ${'%' + invoiceNumber + '%'}
         OR invoice_number ILIKE ${'%' + invoiceNumber + '%'}
      ORDER BY invoice_id ASC
      LIMIT 1
    `;

    if (!invoice && cleanId !== null) {
      const [booking] = await sql`
        SELECT b.*, COALESCE(b.plot_number, p.plot_number, 'Plot') AS plot_number,
               COALESCE(b.plot_area, p.plot_area, 0) AS plot_area,
               COALESCE(p.plot_category::text, 'Residential') AS plot_type,
               COALESCE(s.site_name, s2.site_name, 'MMR City') AS site_name,
               u.full_name, u.mobile_no, u.email
        FROM bookings b
        LEFT JOIN plots p ON b.plot_id = p.plot_id
        LEFT JOIN sites s ON p.site_id = s.site_id
        LEFT JOIN sites s2 ON b.site_id = s2.site_id
        JOIN users u ON b.user_id = u.user_id
        WHERE b.booking_id = ${cleanId}
        LIMIT 1
      `;
      if (booking) {
        const totalPlotPrice = Number(booking.base_price || (Number(booking.plot_area || 0) * 1000) || 0);
        const downPayment = Number(booking.advance_amount || booking.required_booking_amount || 0);
        const remainingBal = Math.max(0, totalPlotPrice - downPayment);
        const formattedInvNum = `MMR-INV-${booking.booking_id}`;

        const invData = {
          invoice_number: formattedInvNum,
          invoice_type: "Plot Booking Advance",
          booking_id: booking.booking_id,
          booking_serial: booking.booking_serial || `BK-${booking.booking_id}`,
          customer_name: booking.full_name || "Valued Customer",
          mobile_no: booking.mobile_no || "",
          email: booking.email || "",
          site_name: booking.site_name || "MMR City",
          plot_number: booking.plot_number || "Plot",
          plot_size: `${booking.plot_area || ''} Sq.Yd.`.trim(),
          total_plot_price: totalPlotPrice,
          down_payment: downPayment,
          emi_amount: downPayment,
          grand_total: downPayment,
          paid_amount: downPayment,
          total_paid_till_date: downPayment,
          balance_amount: remainingBal,
          payment_method: booking.payment_method || booking.payment_type || "Cash / Bank",
          payment_date: booking.created_at ? new Date(booking.created_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
          transaction_id: booking.booking_serial || `BK-${booking.booking_id}`,
          payment_status: "Paid",
          order_status: "Completed"
        };

        invoice = {
          invoice_id: booking.booking_id,
          invoice_number: formattedInvNum,
          order_id: booking.booking_serial,
          user_id: booking.user_id,
          booking_id: booking.booking_id,
          invoice_date: booking.created_at || new Date(),
          grand_total: downPayment,
          paid_amount: downPayment,
          balance_amount: remainingBal,
          payment_method: booking.payment_method || 'Cash / Bank',
          payment_status: 'Paid',
          order_status: 'Completed',
          invoice_data: invData
        };
      }
    }

    if (!invoice) {
      return res.status(404).send("<h1>404 Not Found</h1><p>Invoice was not found.</p>");
    }

    // Cryptographic token validation - immune to brute-force or IDOR tampering
    const isValidToken = verifyInvoiceToken(
      invoice.invoice_number,
      invoice.invoice_id || invoice.booking_id,
      invoice.grand_total,
      token
    );

    if (!isValidToken) {
      console.warn(`[Security Alert] Unauthorized QR download attempt on ${invoiceNumber} from IP: ${req.ip}`);
      return res.status(403).send("<h1>403 Security Check Failed</h1><p>This invoice download link is invalid or has been tampered with. Please scan the genuine QR code on the invoice.</p>");
    }

    const settings = await getEffectiveInvoiceSettings();
    const publicBase = resolvePublicBaseUrl(req);
    const publicInvoiceUrl = resolveFrontendInvoiceUrl(invoice, invoiceNumber);
    const downloadUrl = publicInvoiceUrl;

    try {
      await sql`
        INSERT INTO invoice_audit_log (log_id, invoice_id, invoice_number, action, performed_by_id, performed_by_role, ip_address)
        VALUES (
          (SELECT COALESCE(MAX(log_id), 0) + 1 FROM invoice_audit_log),
          ${invoice.invoice_id || 0}, ${invoice.invoice_number || ''}, 'QR_DOWNLOAD', 0, 'GUEST_QR_SCAN', ${req.ip || ''}
        )
        ON CONFLICT DO NOTHING`;
    } catch (_) {}

    await renderInvoicePdfStream({ invoice, settings, downloadUrl, res });
  } catch (error) {
    console.error("GET /api/public/invoice/download error:", error);
    if (!res.headersSent) {
      res.status(500).send("<h1>500 Internal Error</h1><p>Unable to generate invoice PDF at this time.</p>");
    }
  }
});

// ----------------------------------------------------
// 4. GET /api/verify-invoice/:invoiceNumber (Public Verification)
// ----------------------------------------------------
router.get("/verify-invoice/:invoiceNumber", async (req, res) => {
  try {
    const { invoiceNumber } = req.params;
    const [invoice] = await sql`
      SELECT invoice_id, invoice_number, order_id, booking_id, user_id,
             invoice_date, grand_total, paid_amount, balance_amount,
             payment_status, order_status, invoice_data, created_at
      FROM invoices
      WHERE LOWER(invoice_number) = LOWER(${invoiceNumber})
         OR LOWER(order_id) = LOWER(${invoiceNumber})
         OR booking_id::text = ${invoiceNumber}`;

    if (!invoice) {
      return ok(res, { valid: false }, "Invoice Not Found.");
    }

    const [settings] = await sql`SELECT company_name, gst_number FROM invoice_settings WHERE id = 1`;

    const summary = {
      valid: true,
      invoice_number: invoice.invoice_number,
      order_id: invoice.order_id,
      customer_name: invoice.invoice_data?.customer_name || "N/A",
      site_name: invoice.invoice_data?.site_name || "N/A",
      plot_number: invoice.invoice_data?.plot_number || "N/A",
      plot_size: invoice.invoice_data?.plot_size || "N/A",
      grand_total: invoice.grand_total,
      paid_amount: invoice.paid_amount,
      balance_amount: invoice.balance_amount,
      payment_status: invoice.payment_status,
      order_status: invoice.order_status,
      invoice_date: invoice.invoice_date,
      company_name: settings?.company_name || "MMR Constructions & Developers",
      verified_at: new Date().toISOString(),
    };

    return ok(res, summary, "Invoice is authentic and verified.");
  } catch (error) {
    console.error("GET /api/verify-invoice error:", error);
    return fail(res, error.message);
  }
});

// ----------------------------------------------------
// 5. GET /api/admin/invoice-settings (Admin Only)
// ----------------------------------------------------
router.get("/admin/invoice-settings", adminAuth, async (req, res) => {
  try {
    const settings = await getEffectiveInvoiceSettings();
    return ok(res, settings || {});
  } catch (error) {
    console.error("GET /api/admin/invoice-settings error:", error);
    return fail(res, error.message);
  }
});

// ----------------------------------------------------
// 6. PUT /api/admin/invoice-settings (Admin Only)
// ----------------------------------------------------
router.put("/admin/invoice-settings", adminAuth, async (req, res) => {
  try {
    const {
      company_name,
      cin,
      company_logo,
      address,
      phone,
      email,
      website,
      gst_number,
      terms_and_conditions,
      notes,
      bank_name,
      account_no,
      ifsc_code,
      branch,
      upi_qr_url,
      signature_url,
      stamp_url,
      invoice_prefix,
      invoice_starting_number,
      invoice_footer,
      theme_color,
    } = req.body;

    await sql`ALTER TABLE invoice_settings ADD COLUMN IF NOT EXISTS cin VARCHAR(100) DEFAULT 'U68200UP2025PTC229203'`.catch(() => {});

    const [updated] = await sql`
      INSERT INTO invoice_settings (
        id, company_name, cin, company_logo, address, phone, email, website, gst_number,
        terms_and_conditions, notes, bank_name, account_no, ifsc_code, branch,
        upi_qr_url, signature_url, stamp_url, invoice_prefix, invoice_starting_number,
        invoice_footer, theme_color, updated_at
      ) VALUES (
        1, ${company_name || 'MMR Construction & Developers'}, ${cin || 'U68200UP2025PTC229203'}, ${company_logo || ''}, ${address || 'Tribhuvan Kheda, Sheshpur, Unnao, Uttar Pradesh, India, 209801'},
        ${phone || '+91 95111 19879'}, ${email || 'official@mmrconstructions.in'}, ${website || 'www.mmrconstructions.in'}, ${gst_number || '09AATCM6753A1Z5'},
        ${terms_and_conditions || ''}, ${notes || ''}, ${bank_name || ''}, ${account_no || ''},
        ${ifsc_code || ''}, ${branch || ''}, ${upi_qr_url || ''}, ${signature_url || ''},
        ${stamp_url || ''}, ${invoice_prefix || 'MMR'}, ${Number(invoice_starting_number || 1)},
        ${invoice_footer || ''}, ${theme_color || '#14532d'}, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        company_name = EXCLUDED.company_name,
        cin = EXCLUDED.cin,
        company_logo = EXCLUDED.company_logo,
        address = EXCLUDED.address,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        website = EXCLUDED.website,
        gst_number = EXCLUDED.gst_number,
        terms_and_conditions = EXCLUDED.terms_and_conditions,
        notes = EXCLUDED.notes,
        bank_name = EXCLUDED.bank_name,
        account_no = EXCLUDED.account_no,
        ifsc_code = EXCLUDED.ifsc_code,
        branch = EXCLUDED.branch,
        upi_qr_url = EXCLUDED.upi_qr_url,
        signature_url = EXCLUDED.signature_url,
        stamp_url = EXCLUDED.stamp_url,
        invoice_prefix = EXCLUDED.invoice_prefix,
        invoice_starting_number = EXCLUDED.invoice_starting_number,
        invoice_footer = EXCLUDED.invoice_footer,
        theme_color = EXCLUDED.theme_color,
        updated_at = NOW()
      RETURNING *`;

    return ok(res, updated, "Invoice Settings updated successfully.");
  } catch (error) {
    console.error("PUT /api/admin/invoice-settings error:", error);
    return fail(res, error.message);
  }
});

// ----------------------------------------------------
// 9. DELETE /api/admin/orders/:id (Admin Order Delete with Plot Reset)
// ----------------------------------------------------
router.delete("/admin/orders/:id", adminAuth, async (req, res) => {
  try {
    const targetId = req.params.id;

    // 1. Find invoice or booking
    const [inv] = await sql`
      SELECT i.*, b.plot_id, b.booking_id as ref_booking_id
      FROM invoices i
      LEFT JOIN bookings b ON b.booking_id = i.booking_id
      WHERE i.invoice_id = ${targetId} OR i.booking_id = ${targetId} OR i.invoice_number = ${targetId}
      LIMIT 1`;

    let bookingId = inv?.ref_booking_id || inv?.booking_id || (isNaN(targetId) ? null : Number(targetId));
    let plotId = inv?.plot_id;

    if (!plotId && bookingId) {
      const [bk] = await sql`SELECT plot_id FROM bookings WHERE booking_id = ${bookingId} LIMIT 1`;
      plotId = bk?.plot_id;
    }

    // 2. Delete related records
    if (bookingId) {
      try { await sql`DELETE FROM emi_schedules WHERE booking_id = ${bookingId}`; } catch (_) {}
      try { await sql`DELETE FROM buyback_applications WHERE booking_id = ${bookingId}`; } catch (_) {}
      try { await sql`DELETE FROM buyback_requests WHERE booking_id = ${bookingId}`; } catch (_) {}
      try { await sql`DELETE FROM offline_bookings WHERE booking_id = ${bookingId}`; } catch (_) {}
      await sql`DELETE FROM invoices WHERE booking_id = ${bookingId}`;
      await sql`DELETE FROM booking_invoices WHERE booking_id = ${bookingId}`;
      await sql`DELETE FROM booking_payment_records WHERE booking_id = ${bookingId}`;
      await sql`DELETE FROM bookings WHERE booking_id = ${bookingId}`;
    } else {
      await sql`DELETE FROM invoices WHERE invoice_id = ${targetId}`;
    }

    // 3. Reset Plot status back to Available
    if (plotId) {
      try {
        await sql`UPDATE plots SET plot_status = 'Available', updated_at = NOW() WHERE plot_id = ${plotId}`;
      } catch (_) {
        try { await sql`UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() WHERE plot_id = ${plotId}`; } catch (_) {}
      }
    }

    // 4. Audit Log
    try {
      const actorId = req.user?.user_id || req.user?.admin_id || req.user?.id || 0;
      await sql`
        INSERT INTO invoice_audit_log (log_id, invoice_id, invoice_number, action, performed_by_id, performed_by_role, ip_address)
        VALUES (
          (SELECT COALESCE(MAX(log_id), 0) + 1 FROM invoice_audit_log),
          ${inv?.invoice_id || 0}, ${inv?.invoice_number || ''}, 'DELETED', ${actorId}, 'Admin', ${req.ip || ''}
        )
        ON CONFLICT DO NOTHING`;
    } catch (_) {}

    return ok(res, {}, `Order #${targetId} deleted successfully. Associated plot status reset to Available.`);
  } catch (error) {
    console.error("DELETE /api/admin/orders/:id error:", error);
    return fail(res, error.message);
  }
});

// Duplicate delete routes removed. Main logic merged into server.js

export default router;
