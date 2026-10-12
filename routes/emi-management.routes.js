/**
 * MMR Construction & Developers Pvt. Ltd.
 * EMI Generation, Invoicing & Commission Testing Engine (Admin)
 *
 * Endpoints:
 * - GET  /api/admin/bookings/:id/emi-status
 * - POST /api/admin/bookings/:id/generate-next-emi
 * - POST /api/admin/bookings/:id/pay-emi-simulate
 */

import express from 'express';
import sql from '../db.js';
import { verifyAdminToken, role } from '../middleware/auth.middleware.js';
import { ensureEmiSchedulesForBooking, ensureReceiptForEmi } from '../services/emi.service.js';
import commissionService from '../services/commissionService.js';

const router = express.Router();

function ok(res, data = null, message = 'Success', extra = {}) {
  return res.json({ success: true, message, data, ...extra });
}

function err(res, message = 'Error', code = 400) {
  return res.status(code).json({ success: false, message });
}

function formatMonthLabel(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'N/A';
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

/**
 * 1. GET /api/admin/bookings/:id/emi-status
 * Returns full status of EMI schedule, invoiced state, and next installment to generate
 */
router.get(
  '/admin/bookings/:id/emi-status',
  verifyAdminToken,
  role('SuperAdmin', 'SiteManager', 'FinanceManager', 'Admin'),
  async (req, res) => {
    try {
      const bid = Number(req.params.id);
      if (!bid) return err(res, 'Valid booking ID is required', 400);

      const [booking] = await sql`
        SELECT b.*,
               COALESCE(u.full_name, 'Customer') AS customer_name,
               COALESCE(u.mobile_no, '') AS customer_mobile,
               COALESCE(u.email, '') AS customer_email,
               COALESCE(p.plot_number, b.plot_number, 'Plot') AS plot_number,
               COALESCE(p.monthly_emi, b.monthly_emi, 0)::numeric AS plot_monthly_emi,
               COALESCE(p.emi_tenure_months, b.emi_tenure_months, 60)::int AS plot_emi_tenure,
               COALESCE(s.site_name, s2.site_name, 'Project Site') AS site_name
        FROM bookings b
        LEFT JOIN users u ON u.user_id = b.user_id
        LEFT JOIN plots p ON p.plot_id = b.plot_id
        LEFT JOIN sites s ON s.site_id = p.site_id
        LEFT JOIN sites s2 ON s2.site_id = b.site_id
        WHERE b.booking_id = ${bid}
      `;

      if (!booking) return err(res, 'Booking not found', 404);

      // Initialize schedule if empty
      await ensureEmiSchedulesForBooking(sql, booking);

      // Fetch all installments
      const emiRows = await sql`
        SELECT e.emi_id, e.installment_no, e.due_date,
               COALESCE(e.emi_amount, 0)::numeric AS emi_amount,
               COALESCE(e.principal_component, e.emi_amount)::numeric AS principal_component,
               COALESCE(e.interest_component, 0)::numeric AS interest_component,
               COALESCE(e.late_fee_amount, 0)::numeric AS late_fee_amount,
               COALESCE(e.total_due, e.emi_amount)::numeric AS total_due,
               COALESCE(e.paid_amount, 0)::numeric AS paid_amount,
               e.paid_date, e.emi_status
        FROM emi_schedules e
        WHERE e.booking_id = ${bid}
        ORDER BY e.installment_no ASC
      `;

      // Fetch all invoices created for this booking
      const invoiceRows = await sql`
        SELECT invoice_id, invoice_number, payment_status, order_status,
               COALESCE((invoice_data->>'installment_no')::int, 0) AS installment_no,
               COALESCE(invoice_data->>'invoice_type', '') AS invoice_type,
               created_at
        FROM invoices
        WHERE booking_id = ${bid}
        ORDER BY invoice_id ASC
      `;

      const invoiceByInstallment = new Map();
      for (const inv of invoiceRows) {
        if (inv.installment_no > 0) {
          invoiceByInstallment.set(inv.installment_no, inv);
        }
      }

      // Format enriched schedule
      const enrichedSchedule = emiRows.map((e) => {
        const inv = invoiceByInstallment.get(e.installment_no);
        const isGenerated = Boolean(inv);
        return {
          emi_id: e.emi_id,
          installment_no: e.installment_no,
          month_label: formatMonthLabel(e.due_date),
          due_date: e.due_date,
          emi_amount: Number(e.emi_amount),
          principal_component: Number(e.principal_component),
          interest_component: Number(e.interest_component),
          paid_amount: Number(e.paid_amount),
          paid_date: e.paid_date,
          emi_status: e.emi_status,
          is_generated: isGenerated,
          invoice_id: inv ? inv.invoice_id : null,
          invoice_number: inv ? inv.invoice_number : null,
          invoice_payment_status: inv ? inv.payment_status : null,
        };
      });

      const totalPlotPrice = Number(booking.base_price || booking.total_price || 0);
      const downPayment = Number(booking.advance_amount || 0);
      const paidEmisSum = enrichedSchedule
        .filter((e) => e.emi_status === 'Paid')
        .reduce((sum, e) => sum + e.paid_amount, 0);
      const totalPaidTillDate = downPayment + paidEmisSum;
      const remainingBalance = Math.max(0, totalPlotPrice - totalPaidTillDate);

      // Determine the active pending installment (generated but not paid yet)
      const currentActivePending = enrichedSchedule.find(
        (e) => e.is_generated && e.emi_status !== 'Paid'
      );

      // Determine the next un-generated installment
      const nextUnGenerated = enrichedSchedule.find((e) => !e.is_generated);

      return ok(res, {
        booking_id: bid,
        booking_serial: booking.booking_serial,
        customer_name: booking.customer_name,
        customer_mobile: booking.customer_mobile,
        plot_number: booking.plot_number,
        site_name: booking.site_name,
        payment_type: booking.payment_type || 'EMI',
        total_plot_price: totalPlotPrice,
        down_payment: downPayment,
        total_paid_amount: totalPaidTillDate,
        remaining_balance: remainingBalance,
        total_installments: enrichedSchedule.length,
        paid_installments_count: enrichedSchedule.filter((e) => e.emi_status === 'Paid').length,
        invoiced_installments_count: enrichedSchedule.filter((e) => e.is_generated).length,
        pending_installments_count: enrichedSchedule.filter((e) => e.emi_status !== 'Paid').length,
        has_active_pending_emi: Boolean(currentActivePending),
        current_active_pending: currentActivePending || null,
        next_to_generate: nextUnGenerated || null,
        is_fully_paid: remainingBalance <= 0,
        schedule: enrichedSchedule,
      });
    } catch (e) {
      console.error('[Admin EMI Status Error]:', e);
      return err(res, e.message);
    }
  }
);

/**
 * 2. POST /api/admin/bookings/:id/generate-next-emi
 * Generates the NEXT monthly EMI demand and official invoice.
 * STRICT IDEMPOTENCY:
 * - If current month's EMI is already generated, 10 clicks will NOT create duplicate invoices.
 * - Only after current is generated/handled does it advance.
 */
router.post(
  '/admin/bookings/:id/generate-next-emi',
  verifyAdminToken,
  role('SuperAdmin', 'SiteManager', 'FinanceManager', 'Admin'),
  async (req, res) => {
    try {
      const bid = Number(req.params.id);
      if (!bid) return err(res, 'Valid booking ID is required', 400);

      // Run inside transaction with Advisory Lock
      const result = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${bid})`;

        const [booking] = await tx`
          SELECT b.*,
                 COALESCE(u.full_name, 'Customer') AS customer_name,
                 COALESCE(u.mobile_no, '') AS customer_mobile,
                 COALESCE(u.email, '') AS customer_email,
                 COALESCE(p.plot_number, b.plot_number, 'Plot') AS plot_number,
                 COALESCE(p.plot_area, b.plot_area, 0) AS plot_area,
                 COALESCE(s.site_name, s2.site_name, 'Project Site') AS site_name
          FROM bookings b
          LEFT JOIN users u ON u.user_id = b.user_id
          LEFT JOIN plots p ON p.plot_id = b.plot_id
          LEFT JOIN sites s ON s.site_id = p.site_id
          LEFT JOIN sites s2 ON s2.site_id = b.site_id
          WHERE b.booking_id = ${bid}
        `;

        if (!booking) throw new Error('Booking not found');

        // Ensure schedule records exist
        await ensureEmiSchedulesForBooking(tx, booking);

        // Fetch installments
        const emiRows = await tx`
          SELECT * FROM emi_schedules
          WHERE booking_id = ${bid}
          ORDER BY installment_no ASC
        `;

        if (emiRows.length === 0) {
          throw new Error('No EMI schedule could be found or created for this booking.');
        }

        // Fetch existing invoices
        const invoiceRows = await tx`
          SELECT invoice_id, invoice_number, payment_status,
                 COALESCE((invoice_data->>'installment_no')::int, 0) AS installment_no,
                 invoice_data
          FROM invoices
          WHERE booking_id = ${bid}
            AND invoice_data->>'invoice_type' = 'EMI Installment Payment'
        `;

        const existingInvoiceMap = new Map();
        for (const inv of invoiceRows) {
          if (inv.installment_no > 0) {
            existingInvoiceMap.set(inv.installment_no, inv);
          }
        }

        // Check if there is an existing generated installment that is STILL PENDING
        for (const emi of emiRows) {
          const inv = existingInvoiceMap.get(emi.installment_no);
          if (inv && emi.emi_status !== 'Paid') {
            const mLabel = formatMonthLabel(emi.due_date);
            return {
              already_generated: true,
              message: `EMI for Month ${emi.installment_no} (${mLabel}) is already generated with Invoice #${inv.invoice_number} (Status: ${emi.emi_status}). Cannot duplicate.`,
              installment_no: emi.installment_no,
              month_label: mLabel,
              due_date: emi.due_date,
              emi_amount: Number(emi.emi_amount),
              invoice_number: inv.invoice_number,
              invoice_id: inv.invoice_id,
              emi_status: emi.emi_status,
            };
          }
        }

        // Find the FIRST installment without an invoice
        let targetEmi = null;
        for (const emi of emiRows) {
          if (!existingInvoiceMap.has(emi.installment_no) && emi.emi_status !== 'Paid') {
            targetEmi = emi;
            break;
          }
        }

        if (!targetEmi) {
          return {
            already_generated: true,
            completed: true,
            message: 'All EMI installments for this booking have already been generated and processed.',
          };
        }

        // Generate official invoice for this target installment
        const currentYear = new Date().getFullYear();
        const [seqRow] = await tx`
          INSERT INTO invoice_number_sequence (year, last_sequence)
          VALUES (${currentYear}, 1)
          ON CONFLICT (year) DO UPDATE SET last_sequence = invoice_number_sequence.last_sequence + 1, updated_at = NOW()
          RETURNING last_sequence
        `;
        const seq = seqRow ? seqRow.last_sequence : 1;
        const invoiceNumber = `MMR-INV-${currentYear}-${String(seq).padStart(6, '0')}`;
        const orderId = `EMI-${targetEmi.emi_id}-${Date.now()}`;

        const totalPlotPrice = Number(booking.base_price || booking.total_price || 0);
        const downPayment = Number(booking.advance_amount || 0);
        const emiAmount = Number(targetEmi.emi_amount || 0);

        const [paidEmisSumRow] = await tx`
          SELECT COALESCE(SUM(paid_amount), 0)::numeric AS sum 
          FROM emi_schedules 
          WHERE booking_id = ${bid} AND emi_status = 'Paid'
        `;
        const totalPaidTillDate = downPayment + Number(paidEmisSumRow?.sum || 0);
        const remainingBalance = Math.max(0, totalPlotPrice - totalPaidTillDate);
        const monthLabel = formatMonthLabel(targetEmi.due_date);

        const invoiceData = {
          invoice_number: invoiceNumber,
          invoice_type: 'EMI Installment Payment',
          emi_id: targetEmi.emi_id,
          installment_no: targetEmi.installment_no,
          emi_number: targetEmi.installment_no,
          month_label: monthLabel,
          booking_id: booking.booking_id,
          booking_serial: booking.booking_serial || `BK-${booking.booking_id}`,
          customer_name: booking.customer_name || 'Valued Customer',
          mobile_no: booking.customer_mobile || '',
          email: booking.customer_email || '',
          site_name: booking.site_name || 'MMR Project Site',
          plot_number: booking.plot_number || 'Plot',
          plot_size: `${booking.plot_area || ''} Sq.Yd. / Sq.Ft.`.trim(),
          total_plot_price: totalPlotPrice,
          down_payment: downPayment,
          emi_amount: emiAmount,
          grand_total: emiAmount,
          paid_amount: 0.00,
          balance_amount: emiAmount,
          payment_method: 'Pending Billing',
          payment_date: targetEmi.due_date,
          due_date: targetEmi.due_date,
          transaction_id: orderId,
          payment_status: 'Pending',
          order_status: 'Pending',
        };

        const [newInvoice] = await tx`
          INSERT INTO invoices (
            invoice_number, order_id, user_id, booking_id, invoice_date, subtotal, discount,
            registration_charges, development_charges, other_charges, grand_total,
            paid_amount, balance_amount, payment_method, payment_status, order_status,
            invoice_data, created_at, updated_at
          ) VALUES (
            ${invoiceNumber}, ${orderId}, ${booking.user_id}, ${bid}, NOW(), ${emiAmount}, 0.00,
            0.00, 0.00, 0.00, ${emiAmount},
            0.00, ${emiAmount}, 'Pending Billing', 'Pending', 'Pending',
            ${JSON.stringify(invoiceData)}::jsonb, NOW(), NOW()
          )
          RETURNING *
        `;

        // Update schedule status to Pending
        await tx`
          UPDATE emi_schedules
          SET emi_status = 'Pending',
              total_due = ${emiAmount},
              updated_at = NOW()
          WHERE emi_id = ${targetEmi.emi_id}
        `;

        return {
          already_generated: false,
          message: `Successfully generated EMI for Month ${targetEmi.installment_no} (${monthLabel}) with Invoice #${invoiceNumber}.`,
          installment_no: targetEmi.installment_no,
          month_label: monthLabel,
          due_date: targetEmi.due_date,
          emi_amount: emiAmount,
          invoice_number: invoiceNumber,
          invoice_id: newInvoice.invoice_id,
          emi_status: 'Pending',
        };
      });

      return ok(res, result, result.message);
    } catch (e) {
      console.error('[Admin Generate Next EMI Error]:', e);
      return err(res, e.message);
    }
  }
);

/**
 * 3. POST /api/admin/bookings/:id/pay-emi-simulate
 * Marks the target pending EMI as Paid, updates balances, and triggers the MLM commission engine!
 */
router.post(
  '/admin/bookings/:id/pay-emi-simulate',
  verifyAdminToken,
  role('SuperAdmin', 'SiteManager', 'FinanceManager', 'Admin'),
  async (req, res) => {
    try {
      const bid = Number(req.params.id);
      const targetInstallmentNo = req.body?.installment_no ? Number(req.body.installment_no) : null;
      const paymentMode = req.body?.payment_mode || 'Cash';
      const referenceNo = req.body?.reference_no || `SIM-${Date.now()}`;

      if (!bid) return err(res, 'Valid booking ID is required', 400);

      const result = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${bid})`;

        const [booking] = await tx`
          SELECT b.*,
                 COALESCE(u.full_name, 'Customer') AS customer_name,
                 COALESCE(u.mobile_no, '') AS customer_mobile,
                 COALESCE(u.email, '') AS customer_email,
                 COALESCE(p.plot_number, b.plot_number, 'Plot') AS plot_number
          FROM bookings b
          LEFT JOIN users u ON u.user_id = b.user_id
          LEFT JOIN plots p ON p.plot_id = b.plot_id
          WHERE b.booking_id = ${bid}
        `;

        if (!booking) throw new Error('Booking not found');

        // Locate target EMI
        let [targetEmi] = targetInstallmentNo
          ? await tx`SELECT * FROM emi_schedules WHERE booking_id = ${bid} AND installment_no = ${targetInstallmentNo}`
          : await tx`SELECT * FROM emi_schedules WHERE booking_id = ${bid} AND emi_status != 'Paid' ORDER BY installment_no ASC LIMIT 1`;

        if (!targetEmi) {
          throw new Error('No pending EMI installment found to pay for this booking.');
        }

        if (targetEmi.emi_status === 'Paid') {
          return {
            already_paid: true,
            message: `Installment #${targetEmi.installment_no} is already Paid.`,
          };
        }

        const emiAmount = Number(targetEmi.emi_amount || 0);

        // 1. Update EMI Schedule
        await tx`
          UPDATE emi_schedules
          SET emi_status = 'Paid',
              paid_amount = ${emiAmount},
              paid_date = CURRENT_DATE,
              late_fee_amount = 0.00,
              updated_at = NOW()
          WHERE emi_id = ${targetEmi.emi_id}
        `;

        // 2. Update Invoice to Paid
        const [inv] = await tx`
          SELECT * FROM invoices
          WHERE booking_id = ${bid}
            AND (
              (invoice_data->>'installment_no')::int = ${targetEmi.installment_no}
              OR (invoice_data->>'emi_id')::int = ${targetEmi.emi_id}
            )
          LIMIT 1
        `;

        if (inv) {
          const invData = inv.invoice_data || {};
          invData.payment_status = 'Paid';
          invData.order_status = 'Completed';
          invData.paid_amount = emiAmount;
          invData.balance_amount = 0.00;
          invData.payment_method = paymentMode;
          invData.transaction_id = referenceNo;

          await tx`
            UPDATE invoices
            SET payment_status = 'Paid',
                order_status = 'Completed',
                paid_amount = ${emiAmount},
                balance_amount = 0.00,
                payment_method = ${paymentMode},
                invoice_data = ${JSON.stringify(invData)}::jsonb,
                updated_at = NOW()
            WHERE invoice_id = ${inv.invoice_id}
          `;
        }

        // 3. Update Booking Remaining Balance
        await tx`
          UPDATE bookings
          SET remaining_balance = GREATEST(0, remaining_balance - ${emiAmount}),
              updated_at = NOW()
          WHERE booking_id = ${bid}
        `;

        // 4. Record Payment Ledger
        const [seqRow] = await tx`SELECT COALESCE(MAX(payment_id), 0)::int + 1 AS next_id FROM payment_ledger`;
        const paymentSerial = `PAY-${new Date().getFullYear()}-${String(seqRow?.next_id || 1).padStart(6, '0')}`;
        const [ledger] = await tx`
          INSERT INTO payment_ledger (
            payment_serial, user_id, booking_id, plot_id,
            payment_mode, payment_purpose, gross_amount, net_allocated_amount,
            payment_date, payment_status, verification_status, utr_number,
            submitted_by_user_id, submitted_by_role, admin_notes, created_at, updated_at
          ) VALUES (
            ${paymentSerial}, ${booking.user_id}, ${bid}, ${booking.plot_id},
            ${paymentMode}, 'EmiPayment', ${emiAmount}, ${emiAmount},
            CURRENT_DATE, 'Approved', 'Verified', ${referenceNo},
            ${req.admin?.admin_id || 1}, 'Admin', 'Admin Simulated EMI Payment', NOW(), NOW()
          )
          RETURNING payment_id
        `;

        // 5. Generate Receipt
        await ensureReceiptForEmi(tx, { ...targetEmi, paid_amount: emiAmount }, booking, {
          user_id: booking.user_id,
          full_name: booking.customer_name,
          mobile_no: booking.customer_mobile,
        }, {
          payment_mode: paymentMode,
          transaction_id: referenceNo
        }).catch((rErr) => console.warn('[EmiReceipt Warning]:', rErr.message));

        // 6. Trigger MLM Commission & Team Salary Distribution Engine
        const commissionResult = await commissionService.generateCommissionForPayment({
          bookingId: bid,
          event: {
            type: 'EmiPayment',
            sourceId: `emi-${targetEmi.emi_id}`,
            receivedAmount: emiAmount,
            principalAmount: Number(targetEmi.principal_component || emiAmount),
            paymentType: 'EMI',
          },
          adminId: req.admin?.admin_id || null,
          db: tx,
        });

        const monthLabel = formatMonthLabel(targetEmi.due_date);

        return {
          already_paid: false,
          installment_no: targetEmi.installment_no,
          month_label: monthLabel,
          paid_amount: emiAmount,
          invoice_number: inv ? inv.invoice_number : null,
          commission: {
            total_distributed: commissionResult.total_commission || 0,
            seller_commission: commissionResult.seller_commission || 0,
            team_members_count: commissionResult.team_members_count || 0,
            undistributed_amount: commissionResult.undistributed_amount || 0,
          },
          message: `Month ${targetEmi.installment_no} (${monthLabel}) EMI of ₹${emiAmount.toLocaleString('en-IN')} paid successfully. Commission distributed to Seller and Team Members!`,
        };
      });

      return ok(res, result, result.message);
    } catch (e) {
      console.error('[Admin Pay EMI Simulate Error]:', e);
      return err(res, e.message);
    }
  }
);

export default router;
