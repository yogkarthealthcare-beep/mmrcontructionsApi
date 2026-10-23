import express from "express";
import sql from "../db.js";
import jwt from "jsonwebtoken";
import { userAuth, adminAuth, optionalAuth } from "../middleware/auth.middleware.js";
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
  if (!reqUser) {
    return Boolean(invoice && (invoice.invoice_number || invoice.booking_id));
  }
  const isAdmin = Boolean(
    reqUser.is_admin ||
    reqUser.admin_id ||
    ["admin", "superadmin", "sitemanager", "accountant", "supportstaff"].includes(String(reqUser.role || "").toLowerCase())
  );
  if (isAdmin) return true;

  const currentUserId = reqUser.user_id || reqUser.id || 0;
  if (!currentUserId) return false;

  if (invoice.user_id && invoice.user_id === currentUserId) return true;
  if (invoice.associate_id && invoice.associate_id === currentUserId) return true;

  // Check booking attribution
  const bookingId = invoice.booking_id || (invoice.invoice_data && invoice.invoice_data.booking_id);
  if (bookingId) {
    try {
      const [bk] = await sql`
        SELECT user_id, associate_id, sold_by_user_id, referred_by_user_id, booked_by_user_id
        FROM bookings WHERE booking_id = ${bookingId} LIMIT 1
      `;
      if (bk) {
        if (bk.user_id === currentUserId ||
            bk.associate_id === currentUserId ||
            bk.sold_by_user_id === currentUserId ||
            bk.referred_by_user_id === currentUserId ||
            bk.booked_by_user_id === currentUserId) {
          return true;
        }
      }
    } catch (_) {}
  }

  // Check if team member
  const isTeamMember = Boolean(
    String(reqUser.role || "").toLowerCase() === "team member" ||
    String(reqUser.user_type || "").toLowerCase() === "team member" ||
    reqUser.team_member_id
  );
  if (isTeamMember) {
    if (bookingId) {
      try {
        const [tmBk] = await sql`
          SELECT 1 FROM bookings
          WHERE booking_id = ${bookingId}
            AND (sold_by_user_id = ${currentUserId} OR referred_by_user_id = ${currentUserId} OR user_id = ${currentUserId})
        `;
        if (tmBk) return true;
      } catch (_) {}
    }
    if (invoice.user_id) {
      try {
        const [tmCust] = await sql`
          SELECT 1 FROM team_member_customer_mapping
          WHERE team_member_id = ${currentUserId} AND customer_id = ${invoice.user_id}
        `;
        if (tmCust) return true;
      } catch (_) {}
    }
  }

  // Check associate downline / referral
  const isAssociate = Boolean(
    reqUser.is_associate ||
    String(reqUser.role || "").toLowerCase() === "associate" ||
    String(reqUser.user_type || "").toLowerCase() === "associate"
  );
  if (isAssociate && invoice.user_id) {
    try {
      const [ref] = await sql`
        SELECT 1 FROM referral_registrations
        WHERE sponsor_user_id = ${currentUserId} AND referred_user_id = ${invoice.user_id}`;
      if (ref) return true;

      const [u] = await sql`
        SELECT 1 FROM users
        WHERE user_id = ${invoice.user_id} AND sponsor_user_id = ${currentUserId}`;
      if (u) return true;

      const [closure] = await sql`
        SELECT 1 FROM mlm_tree_closure
        WHERE ancestor_user_id = ${currentUserId} AND descendant_user_id = ${invoice.user_id}`;
      if (closure) return true;
    } catch (_) {}
  }

  return false;
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
        SELECT e.*, b.booking_serial, b.plot_id, b.site_id, b.advance_amount, b.total_amount,
               b.base_price, b.created_at AS booking_created_at,
               COALESCE(b.plot_number, p.plot_number, 'Plot') AS plot_number,
               COALESCE(b.plot_area, p.plot_area, 0) AS plot_area,
               COALESCE(s.site_name, 'MMR City') AS site_name,
               u.full_name, u.mobile_no, u.email, u.father_name, u.address,
               assoc.full_name AS associate_name, assoc.mobile_no AS associate_mobile, assoc.user_id AS associate_user_id
        FROM emi_schedules e
        JOIN bookings b ON e.booking_id = b.booking_id
        LEFT JOIN plots p ON b.plot_id = p.plot_id
        LEFT JOIN sites s ON COALESCE(b.site_id, p.site_id) = s.site_id
        JOIN users u ON e.user_id = u.user_id
        LEFT JOIN users assoc ON b.associate_id = assoc.user_id
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
    if (!invoice && cleanId !== null) {
      const [booking] = await sql`
        SELECT b.*, COALESCE(b.plot_number, p.plot_number, 'Plot') AS plot_number,
               COALESCE(b.plot_area, p.plot_area, 0) AS plot_area,
               COALESCE(p.plot_category::text, 'Residential') AS plot_type,
               COALESCE(p.plot_category::text, 'Residential') AS plot_category,
               COALESCE(p.base_price, b.total_amount, b.base_price, (Number(b.plot_area || 0) * 1000)) AS calc_price,
               COALESCE(s.site_name, s2.site_name, 'MMR City') AS site_name,
               u.full_name, u.mobile_no, u.email, u.father_name, u.address,
               assoc.full_name AS associate_name, assoc.mobile_no AS associate_mobile, assoc.user_id AS associate_user_id
        FROM bookings b
        LEFT JOIN plots p ON b.plot_id = p.plot_id
        LEFT JOIN sites s ON p.site_id = s.site_id
        LEFT JOIN sites s2 ON b.site_id = s2.site_id
        JOIN users u ON b.user_id = u.user_id
        LEFT JOIN users assoc ON b.associate_id = assoc.user_id
        WHERE b.booking_id = ${cleanId}
        LIMIT 1
      `;

      if (booking) {
        const totalPlotPrice = Number(booking.calc_price || booking.base_price || booking.total_amount || (Number(booking.plot_area || 0) * 1000) || 0);
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
                 COALESCE(p.base_price, b.total_amount, b.base_price, (Number(b.plot_area || 0) * 1000)) AS calc_price,
                 COALESCE(s.site_name, 'MMR City') AS site_name,
                 u.father_name, u.address,
                 assoc.full_name AS associate_name, assoc.mobile_no AS associate_mobile, assoc.user_id AS associate_user_id
          FROM bookings b
          LEFT JOIN plots p ON b.plot_id = p.plot_id
          LEFT JOIN sites s ON COALESCE(b.site_id, p.site_id) = s.site_id
          JOIN users u ON b.user_id = u.user_id
          LEFT JOIN users assoc ON b.associate_id = assoc.user_id
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
    try {
      const actorId = req.user.user_id || req.user.admin_id || req.user.id || 0;
      const actorRole = req.user.role || (req.user.admin_id ? 'Admin' : 'USER');
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
router.get("/invoice/:invoiceNumber/pdf", optionalAuth, async (req, res) => {
  try {
    const { invoiceNumber } = req.params;
    const cleanNum = String(invoiceNumber || "").replace(/^MMR-INV-/i, "").replace(/^BK-/i, "").replace(/^INV-/i, "").trim();
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

    if (!invoice) return fail(res, "Invoice not found.", 404);

    const hasAccess = await canAccessInvoice(req.user, invoice);
    if (!hasAccess) return fail(res, "Unauthorized to access this invoice.", 403);

    const [config] = await sql`SELECT * FROM invoice_settings WHERE id = 1`;
    const settings = config || {};
    const data = invoice.invoice_data || {};

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
    } catch (auditErr) {
      console.warn("Invoice download audit log non-critical warning:", auditErr.message);
    }

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

    const payType = String(data.payment_type || invoice.payment_method || '').toLowerCase();
    const isOneTime = Boolean(data.is_one_time || payType.includes('full') || payType.includes('onetime') || payType.includes('one time'));
    const isPartWise = Boolean(data.is_part_wise || payType.includes('part') || (!isOneTime && Number(invoice.balance_amount || 0) > 0 && !data.is_emi));
    const isEmi = Boolean(data.is_emi || payType.includes('emi') || payType.includes('installment'));

    const summaryItems = [
      ["Subtotal Plot Cost", `INR ${Number(data.total_plot_price || invoice.subtotal || 0).toLocaleString("en-IN")}`],
      ["Discount", `INR ${Number(data.discount || invoice.discount || 0).toLocaleString("en-IN")}`],
      ["Registration / Statutory Charges", `INR ${Number(data.registration_charges || invoice.registration_charges || 0).toLocaleString("en-IN")}`],
      ["Other / Development Charges", `INR ${Number(data.other_charges || invoice.other_charges || 0).toLocaleString("en-IN")}`],
      ["Grand Total Payable", `INR ${Number(invoice.grand_total || 0).toLocaleString("en-IN")}`],
      ["Amount Paid Till Date", `INR ${Number(isOneTime ? (invoice.grand_total || data.total_plot_price || invoice.paid_amount) : (invoice.paid_amount || 0)).toLocaleString("en-IN")}`],
      ["Remaining Balance Amount", isOneTime ? "INR 0 (Paid in Full)" : `INR ${Number(invoice.balance_amount || 0).toLocaleString("en-IN")}`],
      ["Payment Method", isOneTime ? "One Time / Full Payment" : (invoice.payment_method || "Online")],
      ["Payment & Order Status", `${isOneTime ? "Paid in Full" : invoice.payment_status} / ${invoice.order_status}`],
    ];

    if (isPartWise && (data.part_wise_deadline_at || invoice.part_wise_deadline_at)) {
      summaryItems.push(["Remaining Payment Due Date", new Date(data.part_wise_deadline_at || invoice.part_wise_deadline_at).toLocaleDateString("en-IN")]);
    }
    if (isEmi && (data.installment_no || data.tenure_months)) {
      if (data.installment_no) {
        summaryItems.push(["EMI Installment Number", `#${data.installment_no} of ${data.tenure_months || 60}`]);
      } else {
        summaryItems.push(["EMI Plan Tenure", `${data.tenure_months || 60} Months`]);
      }
    }

    for (const [lbl, val] of summaryItems) {
      const isBold = lbl.includes("Grand Total") || lbl.includes("Amount Paid") || lbl.includes("Balance") || lbl.includes("Due Date");
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
