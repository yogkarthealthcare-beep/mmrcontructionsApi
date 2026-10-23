/**
 * MMR Construction & Developers Pvt. Ltd.
 * Dedicated Admin Plot Booking Orders Management API
 * 
 * Endpoints:
 * 1. GET   /api/admin/plot-orders          - List all plot booking orders with filters & stats
 * 2. GET   /api/admin/plot-orders/:id      - Get full details of a specific plot booking order
 * 3. PATCH /api/admin/plot-orders/:id/status - Approve, Reject or update status of an order
 * 4. POST  /api/admin/plot-orders/:id/generate-invoice - Ensure/generate invoice record
 */

import express from 'express';
import sql from '../db.js';
import { verifyAdminToken, role } from '../middleware/auth.middleware.js';
import commissionService from '../services/commissionService.js';
import { setPlotStatus } from '../services/plotStatus.service.js';

const router = express.Router();

function ok(res, data = null, message = 'Success', extra = {}) {
  return res.json({ success: true, message, data, ...extra });
}

function err(res, message = 'Error', code = 400) {
  return res.status(code).json({ success: false, message });
}

/**
 * 1. GET /api/admin/plot-orders
 * List plot booking orders with rich search, pagination, and summary KPIs.
 */
router.get('/admin/plot-orders', verifyAdminToken, async (req, res) => {
  try {
    const {
      search = '',
      status = '',
      booking_type = '',
      site_id = '',
      payment_type = '',
      from_date = '',
      to_date = '',
      page = 1,
      limit = 15,
      sort_by = 'latest'
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
        OR p.plot_number ILIKE ${'%' + q + '%'}
        OR s.site_name ILIKE ${'%' + q + '%'}
        OR seller.full_name ILIKE ${'%' + q + '%'}
        OR seller.member_id ILIKE ${'%' + q + '%'}
        OR assoc.full_name ILIKE ${'%' + q + '%'}
        OR assoc.member_id ILIKE ${'%' + q + '%'}
      )
    ` : sql`TRUE`;

    const statusFilter = status && status !== 'ALL'
      ? (status === 'Approved' || status === 'Confirmed'
          ? sql`b.booking_status IN ('Confirmed', 'Approved')`
          : (status === 'Pending'
              ? sql`b.booking_status IN ('Pending', 'PaymentPending', 'Under Process')`
              : sql`b.booking_status ILIKE ${status}`))
      : sql`TRUE`;

    const bookingTypeFilter = booking_type && booking_type !== 'ALL'
      ? (booking_type === 'SELF_PURCHASE'
          ? sql`(b.booking_type = 'SELF_PURCHASE' OR b.user_id = b.sold_by_user_id OR b.user_id = b.booked_by_user_id)`
          : sql`(b.booking_type != 'SELF_PURCHASE' AND b.user_id != COALESCE(b.sold_by_user_id, 0))`)
      : sql`TRUE`;

    const siteFilter = site_id ? sql`p.site_id = ${Number(site_id)}` : sql`TRUE`;
    const paymentTypeFilter = payment_type ? sql`b.payment_type = ${payment_type}` : sql`TRUE`;
    const fromDateFilter = from_date ? sql`b.created_at >= ${from_date}::timestamptz` : sql`TRUE`;
    const toDateFilter = to_date ? sql`b.created_at <= (${to_date}::date + INTERVAL '1 day')::timestamptz` : sql`TRUE`;

    // Calculate aggregated metrics
    const [metrics] = await sql`
      SELECT
        COUNT(*)::int AS total_orders,
        COUNT(CASE WHEN b.booking_status IN ('Confirmed', 'Approved') THEN 1 END)::int AS approved_count,
        COUNT(CASE WHEN b.booking_status IN ('Pending', 'PaymentPending', 'Under Process') THEN 1 END)::int AS pending_count,
        COUNT(CASE WHEN b.booking_status = 'Rejected' THEN 1 END)::int AS rejected_count,
        COUNT(CASE WHEN (b.booking_type = 'SELF_PURCHASE' OR b.user_id = b.sold_by_user_id OR b.user_id = b.booked_by_user_id) THEN 1 END)::int AS self_purchase_count,
        COUNT(CASE WHEN (b.booking_type != 'SELF_PURCHASE' AND b.user_id != COALESCE(b.sold_by_user_id, 0)) THEN 1 END)::int AS customer_sale_count,
        COALESCE(SUM(COALESCE(b.base_price, p.sold_price, p.base_price, (b.advance_amount + b.remaining_balance), 0)), 0)::numeric AS total_sales_volume,
        COALESCE(SUM(COALESCE(b.advance_amount, 0)), 0)::numeric AS total_advance_volume
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      LEFT JOIN users seller ON seller.user_id = b.sold_by_user_id
      LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id
      WHERE ${searchFilter}
        AND ${statusFilter}
        AND ${bookingTypeFilter}
        AND ${siteFilter}
        AND ${paymentTypeFilter}
        AND ${fromDateFilter}
        AND ${toDateFilter}
    `;

    // Query paginated orders with enriched joins
    const orders = await sql`
      SELECT
        b.booking_id,
        b.booking_serial,
        COALESCE(b.booking_date, b.created_at) AS booking_date,
        b.booking_status,
        b.workflow_status,
        b.associate_approval_status,
        b.associate_rejection_reason,
        b.booking_type,
        (b.booking_type = 'SELF_PURCHASE' OR b.user_id = b.sold_by_user_id OR b.user_id = b.booked_by_user_id) AS is_self_purchase,
        b.payment_type,
        b.payment_method,
        COALESCE(b.advance_amount, 0) AS advance_amount,
        COALESCE(b.remaining_balance, 0) AS remaining_balance,
        COALESCE(b.base_price, p.sold_price, p.base_price, (b.advance_amount + b.remaining_balance), 0) AS total_agreed_price,
        b.notes,
        b.created_at,
        b.confirmed_at,

        -- Buyer details
        b.user_id AS buyer_user_id,
        buyer.full_name AS buyer_name,
        buyer.member_id AS buyer_member_id,
        buyer.mobile_no AS buyer_mobile,
        buyer.email AS buyer_email,
        buyer.user_type AS buyer_user_type,
        COALESCE(b_addr.city, '') AS buyer_city,

        -- Sold by (Team Member) details
        b.sold_by_user_id,
        seller.full_name AS team_member_name,
        seller.member_id AS team_member_member_id,
        seller.mobile_no AS team_member_mobile,
        seller.user_type AS team_member_user_type,

        -- Associate details
        b.associate_user_id,
        assoc.full_name AS associate_name,
        assoc.member_id AS associate_member_id,
        assoc.mobile_no AS associate_mobile,

        -- Booker details (who placed the booking)
        b.booked_by_user_id,
        booker.full_name AS booked_by_name,
        booker.member_id AS booked_by_member_id,

        -- Plot details
        p.plot_id,
        p.plot_number,
        COALESCE(p.plot_area, 0) AS plot_area,
        'Gaj' AS area_unit,
        COALESCE(p.plot_status, 'Vacant') AS plot_status,
        COALESCE(p.unit_type, 'PLOT') AS unit_type,

        -- Site details
        s.site_id,
        s.site_name,
        COALESCE(s.location, '') AS site_location,
        COALESCE(s.city, '') AS site_city,

        -- Invoice details
        inv.invoice_id,
        inv.invoice_number,
        inv.payment_status AS invoice_payment_status,
        inv.paid_amount AS invoice_paid_amount

      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      LEFT JOIN user_addresses b_addr ON b_addr.user_id = b.user_id AND b_addr.address_type = 'Permanent'
      LEFT JOIN users seller ON seller.user_id = b.sold_by_user_id
      LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id
      LEFT JOIN users booker ON booker.user_id = b.booked_by_user_id
      LEFT JOIN LATERAL (
        SELECT invoice_id, invoice_number, payment_status, paid_amount
        FROM invoices
        WHERE booking_id = b.booking_id
        ORDER BY invoice_id DESC
        LIMIT 1
      ) inv ON TRUE
      WHERE ${searchFilter}
        AND ${statusFilter}
        AND ${bookingTypeFilter}
        AND ${siteFilter}
        AND ${paymentTypeFilter}
        AND ${fromDateFilter}
        AND ${toDateFilter}
      ORDER BY b.booking_id DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const total = metrics?.total_orders || 0;
    const totalPages = Math.ceil(total / limitNum) || 1;

    return ok(res, {
      orders,
      metrics: {
        total_orders: metrics?.total_orders || 0,
        approved_count: metrics?.approved_count || 0,
        pending_count: metrics?.pending_count || 0,
        rejected_count: metrics?.rejected_count || 0,
        self_purchase_count: metrics?.self_purchase_count || 0,
        customer_sale_count: metrics?.customer_sale_count || 0,
        total_sales_volume: Number(metrics?.total_sales_volume || 0),
        total_advance_volume: Number(metrics?.total_advance_volume || 0)
      },
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: totalPages
      }
    }, 'Plot orders fetched successfully');
  } catch (e) {
    console.error('[AdminPlotOrders] Error fetching orders:', e);
    return err(res, e.message || 'Failed to fetch plot orders', 500);
  }
});

/**
 * 2. GET /api/admin/plot-orders/:id
 * Get full detailed specs for a single plot booking order.
 */
router.get('/admin/plot-orders/:id', verifyAdminToken, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    if (!bookingId || bookingId <= 0) return err(res, 'Invalid booking ID', 400);

    const [order] = await sql`
      SELECT
        b.*,
        (b.booking_type = 'SELF_PURCHASE' OR b.user_id = b.sold_by_user_id OR b.user_id = b.booked_by_user_id) AS is_self_purchase,
        COALESCE(b.base_price, p.sold_price, p.base_price, (b.advance_amount + b.remaining_balance), 0) AS total_agreed_price,

        -- Buyer
        buyer.full_name AS buyer_name,
        buyer.member_id AS buyer_member_id,
        buyer.mobile_no AS buyer_mobile,
        buyer.email AS buyer_email,
        buyer.user_type AS buyer_user_type,
        COALESCE(b_addr.address_line1, '') AS buyer_address,
        COALESCE(b_addr.city, '') AS buyer_city,
        COALESCE(b_addr.state, '') AS buyer_state,
        COALESCE(b_addr.pin_code, '') AS buyer_pincode,
        COALESCE(k.status, 'Not Submitted') AS buyer_kyc_status,

        -- Team Member
        seller.full_name AS team_member_name,
        seller.member_id AS team_member_member_id,
        seller.mobile_no AS team_member_mobile,
        seller.email AS team_member_email,
        seller.user_type AS team_member_user_type,

        -- Associate
        assoc.full_name AS associate_name,
        assoc.member_id AS associate_member_id,
        assoc.mobile_no AS associate_mobile,

        -- Booker
        booker.full_name AS booked_by_name,
        booker.member_id AS booked_by_member_id,

        -- Plot
        p.plot_number,
        COALESCE(p.plot_area, 0) AS plot_area,
        'Gaj' AS area_unit,
        COALESCE(p.plot_status, 'Vacant') AS plot_status,
        COALESCE(p.unit_type, 'PLOT') AS unit_type,
        'East Facing' AS facing,
        COALESCE(p.base_price, 0) AS plot_master_base_price,

        -- Site
        s.site_name,
        COALESCE(s.location, '') AS site_location,
        COALESCE(s.full_address, s.location, '') AS site_address,
        COALESCE(s.city, '') AS site_city,
        'Uttar Pradesh' AS site_state,
        '' AS site_description,

        -- Invoices
        inv.invoice_id,
        inv.invoice_number,
        inv.payment_status AS invoice_payment_status,
        inv.paid_amount AS invoice_paid_amount,
        inv.balance_amount AS invoice_balance_amount,
        inv.grand_total AS invoice_grand_total

      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      LEFT JOIN user_addresses b_addr ON b_addr.user_id = b.user_id AND b_addr.address_type = 'Permanent'
      LEFT JOIN user_kyc_profiles k ON k.user_id = b.user_id
      LEFT JOIN users seller ON seller.user_id = b.sold_by_user_id
      LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id
      LEFT JOIN users booker ON booker.user_id = b.booked_by_user_id
      LEFT JOIN LATERAL (
        SELECT * FROM invoices
        WHERE booking_id = b.booking_id
        ORDER BY invoice_id DESC
        LIMIT 1
      ) inv ON TRUE
      WHERE b.booking_id = ${bookingId}
    `;

    if (!order) {
      return err(res, 'Booking order not found', 404);
    }

    // Fetch related payment transactions or receipts if any
    const payments = await sql`
      SELECT
        payment_id,
        amount,
        payment_date,
        payment_mode,
        payment_status,
        transaction_id,
        receipt_no
      FROM payments
      WHERE booking_id = ${bookingId}
      ORDER BY payment_id DESC
    `.catch(() => []);

    return ok(res, { order, payments }, 'Booking order details retrieved successfully');
  } catch (e) {
    console.error('[AdminPlotOrders] Error fetching order detail:', e);
    return err(res, e.message || 'Failed to fetch booking order details', 500);
  }
});

/**
 * 3. PATCH /api/admin/plot-orders/:id/status
 * Direct approval or rejection from Admin Panel with full status consistency.
 * 
 * Rules:
 * - If status is 'Confirmed' or 'Approved':
 *   - Booking is marked 'Confirmed'
 *   - Plot is set to 'Sold' (or 'Booked')
 *   - Associate approval status is set to 'Approved'
 *   - Self-Purchase check: If buyer is buying for self, 0% commission is enforced!
 *     Commission is skipped with a clear record in logs.
 * - If status is 'Rejected':
 *   - Booking status marked 'Rejected'
 *   - Plot status reverted to 'Vacant'
 */
router.patch('/admin/plot-orders/:id/status', verifyAdminToken, role('SuperAdmin', 'Admin', 'FinanceManager'), async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const { status, reason, remarks } = req.body || {};

    if (!bookingId || bookingId <= 0) return err(res, 'Invalid booking ID', 400);
    if (!status || !['Confirmed', 'Approved', 'Rejected', 'Pending', 'Under Process'].includes(status)) {
      return err(res, "Status must be 'Confirmed'/'Approved', 'Rejected', 'Pending', or 'Under Process'", 400);
    }

    const adminId = req.admin?.admin_id || req.user?.admin_id || 1;
    const adminName = req.admin?.username || req.admin?.full_name || 'Admin';

    const [booking] = await sql`
      SELECT b.*, p.plot_id, p.plot_status, p.site_id,
             (b.booking_type = 'SELF_PURCHASE' OR b.user_id = b.sold_by_user_id OR b.user_id = b.booked_by_user_id) AS is_self_purchase
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      WHERE b.booking_id = ${bookingId}
    `;

    if (!booking) return err(res, 'Booking order not found', 404);

    const isApprove = (status === 'Confirmed' || status === 'Approved');
    const isReject = (status === 'Rejected');
    const effectiveStatus = isApprove ? 'Confirmed' : (isReject ? 'Rejected' : status);

    let updatedOrder = null;

    if (isApprove) {
      // 1. Mark booking confirmed and associate approval approved
      [updatedOrder] = await sql`
        UPDATE bookings
        SET
          booking_status = 'Confirmed',
          associate_approval_status = 'Approved',
          confirmed_at = COALESCE(confirmed_at, NOW()),
          notes = CASE
            WHEN ${remarks || reason || ''} != '' THEN CONCAT(COALESCE(notes, ''), ' | Admin Note: ', ${remarks || reason})
            ELSE notes
          END
        WHERE booking_id = ${bookingId}
        RETURNING *
      `;

      // 2. Update plot status to Sold or Booked
      if (booking.plot_id) {
        await sql`
          UPDATE plots
          SET plot_status = 'Sold', sold_at = COALESCE(sold_at, NOW()), updated_at = NOW()
          WHERE plot_id = ${booking.plot_id}
        `.catch(() => {});

        // Log plot status history
        await sql`
          INSERT INTO plot_status_history (plot_id, old_status, new_status, changed_by_user_id, admin_name, remarks)
          VALUES (${booking.plot_id}, ${booking.plot_status || 'Vacant'}, 'Sold', ${adminId}, ${adminName}, ${remarks || 'Approved by Admin in Plot Orders'})
        `.catch(() => {});
      }

      // 3. Ensure Invoice exists
      const [existingInv] = await sql`
        SELECT invoice_id, invoice_number FROM invoices WHERE booking_id = ${bookingId} LIMIT 1
      `.catch(() => []);

      if (!existingInv) {
        const invNum = `MMR-INV-${new Date().getFullYear()}-${String(bookingId).padStart(6, '0')}`;
        const saleVal = Number(booking.base_price || booking.advance_amount || 0);
        const advVal = Number(booking.advance_amount || 0);
        await sql`
          INSERT INTO invoices (
            invoice_number, booking_id, user_id, associate_id, invoice_date,
            subtotal, grand_total, paid_amount, balance_amount, payment_status, payment_method
          ) VALUES (
            ${invNum}, ${bookingId}, ${booking.user_id}, ${booking.associate_user_id || null}, NOW(),
            ${saleVal}, ${saleVal}, ${advVal}, ${Math.max(0, saleVal - advVal)},
            ${advVal >= saleVal ? 'Paid' : (advVal > 0 ? 'Partially Paid' : 'Unpaid')},
            ${booking.payment_method || 'Bank Transfer'}
          )
        `.catch(invErr => console.error('[AdminPlotOrders] Invoice creation warning:', invErr.message));
      }

      // 4. Commission check:
      // USER RULE: "कस्टमर अपने सेल्फ के लिए लगाता है, तो फिर उसमें ना ही किसी तरह का कमीशन होगा और ना ही कोई पेमेंट कटेगा। ये पूरा का पूरा जो पेमेंट होगा, इसका जो कस्टमर, जो टीम मेंबर है, ये जो भी ओनर है टीम मेंबर, ये उसको देगा।"
      if (booking.is_self_purchase || booking.booking_type === 'SELF_PURCHASE' || booking.user_id === booking.sold_by_user_id) {
        console.log(`[AdminPlotOrders] Booking #${bookingId} is SELF_PURCHASE by Member #${booking.user_id}. Commission is strictly 0%.`);
      } else {
        // Standard sale: trigger commission calculation if advance amount > 0
        if (Number(booking.advance_amount) > 0 && booking.sold_by_user_id) {
          try {
            await commissionService.generateCommissionForPayment({
              bookingId,
              event: {
                type: 'BookingAdvance',
                sourceRef: `adv-${bookingId}`,
                receivedAmount: Number(booking.advance_amount),
                paymentType: booking.payment_type || 'Standard'
              },
              adminId
            });
          } catch (commErr) {
            console.error('[AdminPlotOrders] Commission generation notice:', commErr.message);
          }
        }
      }

    } else if (isReject) {
      // 1. Mark booking rejected
      [updatedOrder] = await sql`
        UPDATE bookings
        SET
          booking_status = 'Rejected',
          associate_approval_status = 'Rejected',
          associate_rejection_reason = ${reason || remarks || 'Rejected by Admin'},
          notes = CASE
            WHEN ${reason || remarks || ''} != '' THEN CONCAT(COALESCE(notes, ''), ' | Rejection Reason: ', ${reason || remarks})
            ELSE notes
          END
        WHERE booking_id = ${bookingId}
        RETURNING *
      `;

      // 2. Revert plot to Vacant
      if (booking.plot_id) {
        await sql`
          UPDATE plots
          SET plot_status = 'Vacant', updated_at = NOW()
          WHERE plot_id = ${booking.plot_id}
        `.catch(() => {});

        // Release locks if any
        await sql`
          UPDATE plot_booking_locks
          SET status = 'Expired', updated_at = NOW()
          WHERE plot_id = ${booking.plot_id} AND status = 'Active'
        `.catch(() => {});

        await sql`
          INSERT INTO plot_status_history (plot_id, old_status, new_status, changed_by_user_id, admin_name, remarks)
          VALUES (${booking.plot_id}, ${booking.plot_status || 'InProcess'}, 'Vacant', ${adminId}, ${adminName}, ${reason || 'Rejected by Admin in Plot Orders'})
        `.catch(() => {});
      }
    } else {
      // Direct status update (Pending / Under Process)
      [updatedOrder] = await sql`
        UPDATE bookings
        SET
          booking_status = ${effectiveStatus},
          notes = CASE
            WHEN ${remarks || ''} != '' THEN CONCAT(COALESCE(notes, ''), ' | Status Update: ', ${remarks})
            ELSE notes
          END
        WHERE booking_id = ${bookingId}
        RETURNING *
      `;
    }

    return ok(res, {
      booking_id: bookingId,
      status: effectiveStatus,
      is_self_purchase: Boolean(booking.is_self_purchase),
      order: updatedOrder
    }, `Booking order status updated to ${effectiveStatus} successfully`);

  } catch (e) {
    console.error('[AdminPlotOrders] Error updating status:', e);
    return err(res, e.message || 'Failed to update booking order status', 500);
  }
});

/**
 * 4. POST /api/admin/plot-orders/:id/generate-invoice
 * Generates an invoice for an order if not already present.
 */
router.post('/admin/plot-orders/:id/generate-invoice', verifyAdminToken, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    if (!bookingId || bookingId <= 0) return err(res, 'Invalid booking ID', 400);

    const [booking] = await sql`
      SELECT b.*, p.plot_id, p.plot_number, p.sold_price, p.base_price AS plot_base_price, s.site_name
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      WHERE b.booking_id = ${bookingId}
    `;

    if (!booking) return err(res, 'Booking order not found', 404);

    let [existingInv] = await sql`
      SELECT * FROM invoices WHERE booking_id = ${bookingId} LIMIT 1
    `.catch(() => []);

    if (existingInv) {
      return ok(res, { invoice: existingInv }, 'Invoice already exists for this order');
    }

    const invNum = `MMR-INV-${new Date().getFullYear()}-${String(bookingId).padStart(6, '0')}`;
    const saleVal = Number(booking.base_price || booking.sold_price || booking.plot_base_price || booking.advance_amount || 0);
    const advVal = Number(booking.advance_amount || 0);

    const [newInv] = await sql`
      INSERT INTO invoices (
        invoice_number, booking_id, user_id, associate_id, invoice_date,
        subtotal, grand_total, paid_amount, balance_amount, payment_status, payment_method
      ) VALUES (
        ${invNum}, ${bookingId}, ${booking.user_id}, ${booking.associate_user_id || null}, NOW(),
        ${saleVal}, ${saleVal}, ${advVal}, ${Math.max(0, saleVal - advVal)},
        ${advVal >= saleVal ? 'Paid' : (advVal > 0 ? 'Partially Paid' : 'Unpaid')},
        ${booking.payment_method || 'Bank Transfer'}
      )
      RETURNING *
    `;

    return ok(res, { invoice: newInv }, 'Invoice generated successfully');
  } catch (e) {
    console.error('[AdminPlotOrders] Error generating invoice:', e);
    return err(res, e.message || 'Failed to generate invoice', 500);
  }
});

export default router;
