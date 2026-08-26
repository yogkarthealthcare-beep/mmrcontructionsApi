import express from "express";
import sql from "../db.js";
import jwt from "jsonwebtoken";
import { userAuth, adminAuth } from "../middleware/auth.middleware.js";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import bwipjs from "bwip-js";

const router = express.Router();

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
  const isAdmin = Boolean(
    reqUser.is_admin ||
    reqUser.admin_id ||
    ["admin", "superadmin", "sitemanager", "accountant", "supportstaff"].includes(String(reqUser.role || "").toLowerCase())
  );
  if (isAdmin) return true;

  const currentUserId = reqUser.user_id || reqUser.id || 0;
  if (invoice.user_id && invoice.user_id === currentUserId) return true;
  if (invoice.associate_id && invoice.associate_id === currentUserId) return true;

  const isAssociate = Boolean(
    reqUser.is_associate ||
    String(reqUser.role || "").toLowerCase() === "associate" ||
    String(reqUser.user_type || "").toLowerCase() === "associate"
  );

  if (isAssociate && currentUserId) {
    // Check if customer was referred by this associate
    const [ref] = await sql`
      SELECT 1 FROM referral_registrations
      WHERE sponsor_user_id = ${currentUserId} AND referred_user_id = ${invoice.user_id}`;
    if (ref) return true;
  }
  return false;
}

// ----------------------------------------------------
// 2. GET /api/invoice/:invoiceNumber (Get Single Invoice JSON)
// ----------------------------------------------------
router.get("/invoice/:invoiceNumber", userAuth, async (req, res) => {
  try {
    const { invoiceNumber } = req.params;
    const [invoice] = await sql`
      SELECT * FROM invoices
      WHERE LOWER(invoice_number) = LOWER(${invoiceNumber})
         OR LOWER(order_id) = LOWER(${invoiceNumber})
         OR booking_id::text = ${invoiceNumber}`;

    if (!invoice) return fail(res, "Invoice not found.", 404);

    const hasAccess = await canAccessInvoice(req.user, invoice);
    if (!hasAccess) return fail(res, "Unauthorized to access this invoice.", 403);

    // Fetch Invoice Settings
    const [settings] = await sql`SELECT * FROM invoice_settings WHERE id = 1`;

    // Generate QR Code Data URL
    const host = req.headers.host || "localhost:4200";
    const protocol = req.protocol || "http";
    const verifyUrl = `${protocol}://${host}/verify-invoice?number=${invoice.invoice_number}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 200 });

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
    const actorId = req.user.user_id || req.user.admin_id || req.user.id || 0;
    const actorRole = req.user.role || (req.user.admin_id ? 'Admin' : 'USER');
    await sql`
      INSERT INTO invoice_audit_log (invoice_id, invoice_number, action, performed_by_id, performed_by_role, ip_address)
      VALUES (${invoice.invoice_id}, ${invoice.invoice_number}, 'VIEWED', ${actorId}, ${actorRole}, ${req.ip || ''})`;

    return ok(res, {
      invoice,
      settings: settings || {},
      qr_code: qrDataUrl,
      barcode: barcodeDataUrl,
      verify_url: verifyUrl,
    });
  } catch (error) {
    console.error("GET /api/invoice/:invoiceNumber error:", error);
    return fail(res, error.message);
  }
});

// ----------------------------------------------------
// 3. GET /api/invoice/:invoiceNumber/pdf (Download PDF)
// ----------------------------------------------------
router.get("/invoice/:invoiceNumber/pdf", userAuth, async (req, res) => {
  try {
    const { invoiceNumber } = req.params;
    const [invoice] = await sql`
      SELECT * FROM invoices
      WHERE LOWER(invoice_number) = LOWER(${invoiceNumber})
         OR LOWER(order_id) = LOWER(${invoiceNumber})
         OR booking_id::text = ${invoiceNumber}`;

    if (!invoice) return fail(res, "Invoice not found.", 404);

    const hasAccess = await canAccessInvoice(req.user, invoice);
    if (!hasAccess) return fail(res, "Unauthorized to access this invoice.", 403);

    const [config] = await sql`SELECT * FROM invoice_settings WHERE id = 1`;
    const settings = config || {};
    const data = invoice.invoice_data || {};

    // Audit Log Entry
    const actorId = req.user.user_id || req.user.admin_id || req.user.id || 0;
    const actorRole = req.user.role || (req.user.admin_id ? 'Admin' : 'USER');
    await sql`
      INSERT INTO invoice_audit_log (invoice_id, invoice_number, action, performed_by_id, performed_by_role, ip_address)
      VALUES (${invoice.invoice_id}, ${invoice.invoice_number}, 'DOWNLOADED', ${actorId}, ${actorRole}, ${req.ip || ''})`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${invoice.invoice_number}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: "A4" });
    doc.pipe(res);

    // Primary Header Branding
    const brandColor = settings.theme_color || "#14532d";
    doc.rect(0, 0, 595.28, 80).fill(brandColor);

    doc.fillColor("#ffffff").fontSize(20).text(settings.company_name || "MMR Constructions & Developers", 40, 20, { align: "left" });
    doc.fontSize(9).fillColor("#e2e8f0").text(settings.address || "Head Office: Lucknow, Uttar Pradesh", 40, 46, { align: "left" });
    doc.fontSize(9).text(`Phone: ${settings.phone || "-"}  |  Email: ${settings.email || "-"}`, 40, 58, { align: "left" });

    // Title & Invoice Meta Box
    doc.moveDown(3);
    doc.fillColor("#1e293b").fontSize(18).text("PLOT BOOKING INVOICE", 40, 100, { align: "left" });

    doc.fontSize(10).fillColor("#64748b").text(`Invoice Number: `, 360, 100, { continued: true });
    doc.fillColor("#14532d").text(invoice.invoice_number);

    doc.fontSize(9).fillColor("#64748b").text(`Invoice Date: `, 360, 114, { continued: true });
    doc.fillColor("#334155").text(new Date(invoice.invoice_date).toLocaleDateString("en-IN"));

    doc.fontSize(9).fillColor("#64748b").text(`Order / Serial ID: `, 360, 128, { continued: true });
    doc.fillColor("#334155").text(invoice.order_id || `BK-${invoice.booking_id}`);

    doc.moveDown();
    doc.lineWidth(1).strokeColor("#cbd5e1").lineCap("butt").moveTo(40, 150).lineTo(555, 150).stroke();

    // Section 1: Customer Details
    let y = 165;
    doc.fillColor("#14532d").fontSize(12).text("CUSTOMER DETAILS", 40, y);
    y += 18;
    const custLines = [
      ["Customer Name", data.customer_name || "-"],
      ["Mobile Number", data.mobile_no || "-"],
      ["Email Address", data.email || "-"],
      ["Booking Date", data.booking_date ? new Date(data.booking_date).toLocaleString("en-IN") : "-"],
    ];

    if (data.associate_name) {
      custLines.push(["Associate / Sponsor", `${data.associate_name} (${data.associate_mobile || "-"})`]);
    }

    for (const [lbl, val] of custLines) {
      doc.fontSize(9).fillColor("#64748b").text(lbl, 40, y, { width: 130 });
      doc.fontSize(9).fillColor("#0f172a").text(String(val), 170, y, { width: 380 });
      y += 14;
    }

    y += 10;
    doc.lineWidth(0.5).strokeColor("#e2e8f0").moveTo(40, y).lineTo(555, y).stroke();

    // Section 2: Property & Plot Details
    y += 12;
    doc.fillColor("#14532d").fontSize(12).text("PLOT & PROPERTY DETAILS", 40, y);
    y += 18;
    const plotLines = [
      ["Project / Site Name", data.site_name || "-"],
      ["Plot Number", data.plot_number || "-"],
      ["Plot Size / Area", data.plot_size || `${data.plot_area_sqft || 0} Sq.Ft.`],
      ["Rate Per Sq.Ft.", `INR ${(data.rate_per_sqft || 0).toLocaleString("en-IN")}`],
      ["Total Plot Price", `INR ${Number(data.total_plot_price || invoice.grand_total || 0).toLocaleString("en-IN")}`],
    ];

    for (const [lbl, val] of plotLines) {
      doc.fontSize(9).fillColor("#64748b").text(lbl, 40, y, { width: 130 });
      doc.fontSize(9).fillColor("#0f172a").text(String(val), 170, y, { width: 380 });
      y += 14;
    }

    y += 10;
    doc.lineWidth(0.5).strokeColor("#e2e8f0").moveTo(40, y).lineTo(555, y).stroke();

    // Section 3: Financial Summary Table
    y += 12;
    doc.fillColor("#14532d").fontSize(12).text("FINANCIAL SUMMARY & PAYMENT STATUS", 40, y);
    y += 18;

    const summaryItems = [
      ["Subtotal Plot Cost", `INR ${Number(data.total_plot_price || invoice.subtotal || 0).toLocaleString("en-IN")}`],
      ["Discount", `INR ${Number(data.discount || invoice.discount || 0).toLocaleString("en-IN")}`],
      ["Registration / Statutory Charges", `INR ${Number(data.registration_charges || invoice.registration_charges || 0).toLocaleString("en-IN")}`],
      ["Other / Development Charges", `INR ${Number(data.other_charges || invoice.other_charges || 0).toLocaleString("en-IN")}`],
      ["Grand Total Payable", `INR ${Number(invoice.grand_total || 0).toLocaleString("en-IN")}`],
      ["Amount Paid Till Date", `INR ${Number(invoice.paid_amount || 0).toLocaleString("en-IN")}`],
      ["Remaining Balance Amount", `INR ${Number(invoice.balance_amount || 0).toLocaleString("en-IN")}`],
      ["Payment Method", invoice.payment_method || "Online"],
      ["Payment & Order Status", `${invoice.payment_status} / ${invoice.order_status}`],
    ];

    for (const [lbl, val] of summaryItems) {
      const isBold = lbl.includes("Grand Total") || lbl.includes("Amount Paid") || lbl.includes("Balance");
      doc.fontSize(9).fillColor(isBold ? "#14532d" : "#64748b").text(lbl, 40, y, { width: 180 });
      doc.fontSize(9).fillColor(isBold ? "#14532d" : "#0f172a").text(String(val), 220, y, { width: 330 });
      y += 14;
    }

    // Terms & Conditions Footer
    y += 20;
    doc.lineWidth(0.5).strokeColor("#cbd5e1").moveTo(40, y).lineTo(555, y).stroke();
    y += 12;

    doc.fontSize(9).fillColor("#14532d").text("Terms & Conditions:", 40, y);
    y += 12;
    doc.fontSize(8).fillColor("#64748b").text(settings.terms_and_conditions || "This is a computer generated invoice.", 40, y, { width: 515 });

    // Authorization Signature Line
    doc.fontSize(9).fillColor("#334155").text("Authorized Signatory", 400, 740, { align: "right" });
    doc.fontSize(8).fillColor("#64748b").text(settings.company_name || "MMR Constructions & Developers", 400, 752, { align: "right" });

    doc.end();
  } catch (error) {
    console.error("GET /api/invoice/:invoiceNumber/pdf error:", error);
    if (!res.headersSent) return fail(res, error.message);
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
    const [settings] = await sql`SELECT * FROM invoice_settings WHERE id = 1`;
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

    const [updated] = await sql`
      INSERT INTO invoice_settings (
        id, company_name, company_logo, address, phone, email, website, gst_number,
        terms_and_conditions, notes, bank_name, account_no, ifsc_code, branch,
        upi_qr_url, signature_url, stamp_url, invoice_prefix, invoice_starting_number,
        invoice_footer, theme_color, updated_at
      ) VALUES (
        1, ${company_name || 'MMR Constructions & Developers'}, ${company_logo || ''}, ${address || ''},
        ${phone || ''}, ${email || ''}, ${website || ''}, ${gst_number || ''},
        ${terms_and_conditions || ''}, ${notes || ''}, ${bank_name || ''}, ${account_no || ''},
        ${ifsc_code || ''}, ${branch || ''}, ${upi_qr_url || ''}, ${signature_url || ''},
        ${stamp_url || ''}, ${invoice_prefix || 'MMR'}, ${Number(invoice_starting_number || 1)},
        ${invoice_footer || ''}, ${theme_color || '#14532d'}, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        company_name = EXCLUDED.company_name,
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
        INSERT INTO invoice_audit_log (invoice_id, action, performed_by, notes)
        VALUES (${inv?.invoice_id || 0}, 'DELETED', ${actorId}, ${'Admin deleted order #' + targetId + '. Plot #' + (plotId || '') + ' reset to Available.'})`;
    } catch (_) {}

    return ok(res, {}, `Order #${targetId} deleted successfully. Associated plot status reset to Available.`);
  } catch (error) {
    console.error("DELETE /api/admin/orders/:id error:", error);
    return fail(res, error.message);
  }
});

// Duplicate delete routes removed. Main logic merged into server.js

export default router;
