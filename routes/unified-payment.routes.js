import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import sql from "../db.js";
import { adminAuth, userAuth } from "../middleware/auth.middleware.js";
import { runHistoricalPaymentMigration } from "../services/unifiedPaymentMigration.service.js";

const router = express.Router();

// ─── JSON RESPONSE HELPERS ────────────────────────────────────
function ok(res, data = null, message = "Success", extra = {}) {
  return res.json({ success: true, message, data, ...extra });
}

function fail(res, message = "Failed", code = 400) {
  return res.status(code).json({ success: false, message });
}

const money = (val) => Number(val || 0);

// ─── SERIAL GENERATORS ────────────────────────────────────────
async function generatePaymentSerial() {
  const year = new Date().getFullYear();
  const [row] = await sql`
    SELECT COUNT(*)::int as count FROM payment_ledger 
    WHERE payment_serial LIKE ${`MMR-PAY-${year}-%`}
  `;
  const nextSeq = (row?.count || 0) + 1;
  return `MMR-PAY-${year}-${String(nextSeq).padStart(5, "0")}`;
}

async function generateCashCollectionSerial() {
  const year = new Date().getFullYear();
  const [row] = await sql`
    SELECT COUNT(*)::int as count FROM cash_collections 
    WHERE collection_serial LIKE ${`MMR-CASH-${year}-%`}
  `;
  const nextSeq = (row?.count || 0) + 1;
  return `MMR-CASH-${year}-${String(nextSeq).padStart(5, "0")}`;
}

async function generateComplaintSerial() {
  const year = new Date().getFullYear();
  const [row] = await sql`
    SELECT COUNT(*)::int as count FROM missing_payment_complaints 
    WHERE complaint_serial LIKE ${`MMR-DISP-${year}-%`}
  `;
  const nextSeq = (row?.count || 0) + 1;
  return `MMR-DISP-${year}-${String(nextSeq).padStart(5, "0")}`;
}

async function generateVoucherSerial() {
  const [row] = await sql`
    SELECT COUNT(*)::int as count FROM payment_vouchers
  `;
  const nextSeq = (row?.count || 0) + 1;
  return `U-${String(nextSeq).padStart(3, "0")}`;
}

async function generateReceiptNumber() {
  const year = new Date().getFullYear();
  const [row] = await sql`
    SELECT MAX(serial_no)::int as max_seq FROM receipts
  `;
  const nextSeq = (row?.max_seq || 0) + 1;
  return {
    receipt_no: `MMR/REC/${year}/${String(nextSeq).padStart(4, "0")}`,
    serial_no: nextSeq
  };
}

// ─── MLM COMMISSION SAFE INVOCATION ────────────────────────────
async function triggerMlmCommission(req, bookingId, sourceType, sourceId, amount, paymentType) {
  try {
    const receivedAmount = money(amount);
    if (receivedAmount <= 0) return { generated: 0, reason: "Zero amount" };

    return await sql.begin(async (db) => {
      await db`SELECT pg_advisory_xact_lock(${Number(bookingId)})`;
      const [booking] = await db`
        SELECT b.booking_id, b.user_id, p.plot_id, p.plot_area, p.base_price, buyer.sponsor_user_id
        FROM bookings b
        JOIN users buyer ON buyer.user_id = b.user_id
        JOIN plots p ON p.plot_id = b.plot_id
        WHERE b.booking_id = ${bookingId}
      `;

      if (!booking?.sponsor_user_id) return { generated: 0, reason: "No sponsor" };

      // Check if commission engine is configured
      const [engine] = await db`
        SELECT * FROM commission_engine_settings WHERE id = 1 AND is_active = TRUE LIMIT 1
      `;
      if (!engine) return { generated: 0, reason: "Commission engine inactive" };

      const [event] = await db`
        INSERT INTO commission_source_events (
          booking_id, source_type, source_id, payment_type, received_amount,
          plot_amount, plot_area_gaj, commission_model, engine_version, generated_by_admin_id
        ) VALUES (
          ${booking.booking_id}, ${sourceType}, ${String(sourceId)}, ${paymentType || 'Standard'},
          ${receivedAmount}, ${Number(booking.base_price || 0)}, ${Number(booking.plot_area || 0)},
          ${engine.commission_model || 'EqualDistribution'}, ${engine.version || 1}, ${req?.admin?.admin_id || null}
        )
        ON CONFLICT (booking_id, source_type, source_id) DO NOTHING
        RETURNING event_id
      `;

      if (!event) return { generated: 0, reason: "Event already processed" };

      console.log(`[MLM Commission] Triggered for booking ${bookingId}, source ${sourceType}-${sourceId}, event ${event.event_id}`);
      return { generated: 1, event_id: event.event_id };
    });
  } catch (err) {
    console.error("[MLM Commission Error]", err.message);
    return { generated: 0, error: err.message };
  }
}

// ─── ALLOCATION ENGINE ────────────────────────────────────────
async function executePaymentAllocation(paymentId, adminId = null) {
  return await sql.begin(async (db) => {
    const [payment] = await db`
      SELECT * FROM payment_ledger WHERE payment_id = ${paymentId} FOR UPDATE
    `;
    if (!payment) throw new Error("Payment not found");
    if (payment.payment_status === "Approved" && payment.verification_status === "Verified") {
      return { success: true, message: "Payment already approved and allocated" };
    }

    const bookingId = payment.booking_id;
    let unallocatedAmount = Number(payment.gross_amount) - Number(payment.late_fee_amount || 0);

    // Fetch booking details
    const [booking] = await db`
      SELECT b.*, p.plot_number, p.plot_area, p.base_price, p.site_id,
             u.full_name as customer_name, u.mobile_no as customer_mobile
      FROM bookings b
      JOIN plots p ON p.plot_id = b.plot_id
      JOIN users u ON u.user_id = b.user_id
      WHERE b.booking_id = ${bookingId}
    `;

    if (!booking) throw new Error("Booking not found");

    // 1. If Purpose is BookingAdvance
    if (payment.payment_purpose === "BookingAdvance") {
      await db`
        INSERT INTO payment_allocations (
          payment_id, booking_id, allocation_type, allocated_amount, status
        ) VALUES (
          ${paymentId}, ${bookingId}, 'BookingAdvance', ${unallocatedAmount}, 'Allocated'
        )
      `;

      await db`
        UPDATE bookings SET
          advance_amount = COALESCE(advance_amount, 0) + ${unallocatedAmount},
          booking_status = CASE WHEN booking_status = 'Submitted' THEN 'Confirmed' ELSE booking_status END,
          updated_at = NOW()
        WHERE booking_id = ${bookingId}
      `;

      await db`
        UPDATE plots SET plot_status = 'Booked', updated_at = NOW()
        WHERE plot_id = ${booking.plot_id} AND plot_status IN ('Vacant', 'InProcess')
      `;
    } 
    // 2. If Purpose is EMI Installment or Partial / Multiple EMIs
    else {
      // Fetch pending / partially paid EMIs ordered by installment_no
      const pendingEmis = await db`
        SELECT * FROM emi_schedules
        WHERE booking_id = ${bookingId} 
          AND emi_status IN ('Pending', 'ProofSubmitted', 'PartiallyPaid', 'Overdue')
        ORDER BY installment_no ASC
      `;

      for (const emi of pendingEmis) {
        if (unallocatedAmount <= 0) break;

        const emiRequired = Number(emi.emi_amount) - Number(emi.partially_paid_amount || 0);

        if (unallocatedAmount >= emiRequired) {
          // Pay this EMI in full
          const allocationAmount = emiRequired;
          unallocatedAmount -= allocationAmount;

          await db`
            INSERT INTO payment_allocations (
              payment_id, booking_id, allocation_type, emi_id, installment_no, allocated_amount, status
            ) VALUES (
              ${paymentId}, ${bookingId}, 'EmiInstallment', ${emi.emi_id}, ${emi.installment_no}, ${allocationAmount}, 'Allocated'
            )
          `;

          await db`
            UPDATE emi_schedules SET
              emi_status = 'Paid',
              paid_amount = ${Number(emi.emi_amount)},
              partially_paid_amount = 0.00,
              paid_date = ${payment.payment_date || new Date().toISOString().split('T')[0]},
              updated_at = NOW()
            WHERE emi_id = ${emi.emi_id}
          `;

          // Check if voucher exists; create if not
          const [voucher] = await db`
            SELECT * FROM payment_vouchers WHERE emi_id = ${emi.emi_id} LIMIT 1
          `;
          let voucherId = voucher?.voucher_id;
          if (!voucher) {
            const vSerial = await generateVoucherSerial();
            const [newVoucher] = await db`
              INSERT INTO payment_vouchers (
                booking_id, emi_id, user_id, voucher_serial, payment_ledger_id
              ) VALUES (
                ${bookingId}, ${emi.emi_id}, ${booking.user_id}, ${vSerial}, ${paymentId}
              )
              RETURNING voucher_id
            `;
            voucherId = newVoucher.voucher_id;
          }

          // Trigger MLM commission for this EMI
          await triggerMlmCommission(
            { admin: { admin_id: adminId } },
            bookingId,
            "EmiPayment",
            emi.emi_id,
            allocationAmount,
            payment.payment_mode
          );
        } else {
          // Partial payment for this EMI
          const partialAllocation = unallocatedAmount;
          unallocatedAmount = 0;

          await db`
            INSERT INTO payment_allocations (
              payment_id, booking_id, allocation_type, emi_id, installment_no, allocated_amount, status
            ) VALUES (
              ${paymentId}, ${bookingId}, 'EmiInstallment', ${emi.emi_id}, ${emi.installment_no}, ${partialAllocation}, 'Allocated'
            )
          `;

          await db`
            UPDATE emi_schedules SET
              emi_status = 'PartiallyPaid',
              partially_paid_amount = COALESCE(partially_paid_amount, 0) + ${partialAllocation},
              updated_at = NOW()
            WHERE emi_id = ${emi.emi_id}
          `;
        }
      }

      // If still excess unallocated amount exists
      if (unallocatedAmount > 0) {
        await db`
          INSERT INTO payment_allocations (
            payment_id, booking_id, allocation_type, allocated_amount, status, notes
          ) VALUES (
            ${paymentId}, ${bookingId}, 'ExcessAdvance', ${unallocatedAmount}, 'Allocated', 'Excess amount kept in plot advance balance'
          )
        `;

        await db`
          UPDATE bookings SET
            unallocated_advance_balance = COALESCE(unallocated_advance_balance, 0) + ${unallocatedAmount},
            updated_at = NOW()
          WHERE booking_id = ${bookingId}
        `;
      }
    }

    // Generate Official Receipt in `receipts` table if not already linked
    let receiptId = payment.receipt_id;
    if (!receiptId) {
      const { receipt_no, serial_no } = await generateReceiptNumber();
      const [newReceipt] = await db`
        INSERT INTO receipts (
          receipt_no, serial_no, plot_no, plot_area, customer_id,
          customer_name, mobile_no, payment_type, payment_mode,
          paid_amount, receipt_amount, receipt_date, notes, status,
          is_locked, payment_ledger_id, created_by
        ) VALUES (
          ${receipt_no}, ${serial_no}, ${booking.plot_number || 'N/A'},
          ${String(booking.plot_area || '')}, ${booking.user_id},
          ${booking.customer_name || 'Valued Customer'}, ${booking.customer_mobile || ''},
          ${payment.payment_mode}, ${payment.payment_purpose},
          ${Number(payment.gross_amount)}, ${Number(payment.gross_amount)},
          ${payment.payment_date || new Date().toISOString().split('T')[0]},
          ${payment.admin_notes || `Unified Payment ${payment.payment_serial}`},
          'Active', TRUE, ${paymentId}, ${adminId || null}
        )
        RETURNING id
      `;
      receiptId = newReceipt.id;
    }

    // Update payment_ledger to Approved & Verified
    await db`
      UPDATE payment_ledger SET
        payment_status = 'Approved',
        verification_status = 'Verified',
        net_allocated_amount = ${Number(payment.gross_amount) - unallocatedAmount},
        excess_unallocated_amount = ${unallocatedAmount},
        receipt_id = ${receiptId},
        approved_by_admin_id = ${adminId || null},
        verified_by_admin_id = ${adminId || null},
        updated_at = NOW()
      WHERE payment_id = ${paymentId}
    `;

    return { success: true, paymentId, receiptId, excessAmount: unallocatedAmount };
  });
}

// ─── 1. CUSTOMER: INITIATE PAYMENT (Online / Offline / Wallet) ───
router.post("/api/payments/initiate", userAuth, async (req, res) => {
  try {
    const userId = req.user.user_id || req.user.userId;
    const {
      booking_id,
      payment_mode, // 'Online', 'Cash', 'Cheque', 'BankTransfer', 'UPI', 'Wallet'
      payment_purpose, // 'BookingAdvance', 'EmiPayment', 'PartialEmi', 'MultipleEmi'
      amount,
      emi_id,
      utr_number,
      cheque_number,
      bank_name,
      cheque_date,
      proof_document_url,
      customer_notes
    } = req.body;

    const grossAmount = money(amount);
    if (grossAmount <= 0) return fail(res, "Amount must be greater than zero", 400);
    if (!booking_id) return fail(res, "Booking ID is required", 400);

    // Verify booking ownership
    const [booking] = await sql`
      SELECT b.*, p.site_id, p.plot_number
      FROM bookings b
      JOIN plots p ON p.plot_id = b.plot_id
      WHERE b.booking_id = ${booking_id} AND b.user_id = ${userId}
    `;
    if (!booking) return fail(res, "Booking not found or not owned by you", 404);

    const paymentSerial = await generatePaymentSerial();

    // 1. If Wallet Payment
    if (payment_mode === "Wallet") {
      // Check wallet balance
      const [wallet] = await sql`
        SELECT * FROM user_wallets WHERE user_id = ${userId} FOR UPDATE
      `;
      if (!wallet || Number(wallet.available_balance || 0) < grossAmount) {
        return fail(res, "Insufficient wallet balance", 400);
      }

      // Deduct wallet balance
      await sql`
        UPDATE user_wallets SET
          available_balance = available_balance - ${grossAmount},
          updated_at = NOW()
        WHERE wallet_id = ${wallet.wallet_id}
      `;

      // Log wallet transaction
      await sql`
        INSERT INTO wallet_transactions (
          wallet_id, user_id, amount, balance_before, balance_after,
          transaction_type, source, status, remarks
        ) VALUES (
          ${wallet.wallet_id}, ${userId}, ${grossAmount},
          ${Number(wallet.available_balance)}, ${Number(wallet.available_balance) - grossAmount},
          'Debit', 'PlotPayment', 'success',
          ${`Payment for Plot ${booking.plot_number} (${paymentSerial})`}
        )
      `;

      // Create approved ledger entry
      const [newPayment] = await sql`
        INSERT INTO payment_ledger (
          payment_serial, user_id, booking_id, plot_id, site_id,
          payment_mode, payment_purpose, gross_amount, net_allocated_amount,
          payment_date, payment_status, verification_status,
          submitted_by_user_id, submitted_by_role, admin_notes
        ) VALUES (
          ${paymentSerial}, ${userId}, ${booking_id}, ${booking.plot_id}, ${booking.site_id},
          'Wallet', ${payment_purpose || 'EmiPayment'}, ${grossAmount}, ${grossAmount},
          CURRENT_DATE, 'Submitted', 'Pending',
          ${userId}, 'Customer', ${customer_notes || null}
        )
        RETURNING payment_id
      `;

      // Execute auto-allocation
      await executePaymentAllocation(newPayment.payment_id);

      return ok(res, { payment_serial: paymentSerial, payment_id: newPayment.payment_id }, "Wallet payment processed and allocated successfully");
    }

    // 2. If Offline / Bank Transfer / UPI / Cheque / Cash Proof
    let chequeId = null;
    if (payment_mode === "Cheque") {
      if (!cheque_number || !bank_name || !cheque_date) {
        return fail(res, "Cheque number, bank name, and cheque date are required", 400);
      }
      const [cheque] = await sql`
        INSERT INTO cheque_registry (
          cheque_number, bank_name, cheque_date, cheque_amount,
          customer_id, booking_id, plot_id, cheque_image_url,
          cheque_status, received_by_user_id
        ) VALUES (
          ${cheque_number}, ${bank_name}, ${cheque_date}, ${grossAmount},
          ${userId}, ${booking_id}, ${booking.plot_id}, ${proof_document_url || null},
          'ChequeReceived', ${userId}
        )
        RETURNING cheque_id
      `;
      chequeId = cheque.cheque_id;
    }

    const [newPayment] = await sql`
      INSERT INTO payment_ledger (
        payment_serial, user_id, booking_id, plot_id, site_id,
        payment_mode, payment_purpose, gross_amount, payment_date,
        payment_status, verification_status, utr_number, cheque_id,
        proof_document_url, submitted_by_user_id, submitted_by_role,
        admin_notes
      ) VALUES (
        ${paymentSerial}, ${userId}, ${booking_id}, ${booking.plot_id}, ${booking.site_id},
        ${payment_mode}, ${payment_purpose || 'EmiPayment'}, ${grossAmount}, CURRENT_DATE,
        'Submitted', 'Pending', ${utr_number || null}, ${chequeId},
        ${proof_document_url || null}, ${userId}, 'Customer',
        ${customer_notes || null}
      )
      RETURNING *
    `;

    // If EMI specified, mark EMI as ProofSubmitted
    if (emi_id) {
      await sql`
        UPDATE emi_schedules SET
          emi_status = 'ProofSubmitted',
          updated_at = NOW()
        WHERE emi_id = ${emi_id} AND booking_id = ${booking_id}
      `;
    }

    return ok(res, newPayment, "Payment submitted successfully. Awaiting verification.");
  } catch (err) {
    console.error("[Initiate Payment Error]", err);
    return fail(res, err.message, 500);
  }
});

// ─── 2. CUSTOMER: REPORT MISSING PAYMENT ────────────────────────
router.post("/api/payments/report-missing", userAuth, async (req, res) => {
  try {
    const userId = req.user.user_id || req.user.userId;
    const {
      booking_id,
      claimed_amount,
      claimed_payment_date,
      claimed_payment_mode,
      claimed_utr_number,
      claimed_cheque_number,
      claimed_receipt_no,
      claimed_collector_name,
      proof_document_url,
      remarks
    } = req.body;

    const amount = money(claimed_amount);
    if (amount <= 0) return fail(res, "Claimed amount must be greater than zero", 400);
    if (!booking_id) return fail(res, "Booking ID is required", 400);

    const [booking] = await sql`
      SELECT b.*, p.plot_id
      FROM bookings b
      JOIN plots p ON p.plot_id = b.plot_id
      WHERE b.booking_id = ${booking_id} AND b.user_id = ${userId}
    `;
    if (!booking) return fail(res, "Booking not found", 404);

    const complaintSerial = await generateComplaintSerial();

    const [complaint] = await sql`
      INSERT INTO missing_payment_complaints (
        complaint_serial, user_id, booking_id, plot_id,
        claimed_amount, claimed_payment_date, claimed_payment_mode,
        claimed_utr_number, claimed_cheque_number, claimed_receipt_no,
        claimed_collector_name, proof_document_url, complaint_status,
        remarks
      ) VALUES (
        ${complaintSerial}, ${userId}, ${booking_id}, ${booking.plot_id},
        ${amount}, ${claimed_payment_date || new Date().toISOString().split('T')[0]},
        ${claimed_payment_mode || 'Cash'}, ${claimed_utr_number || null},
        ${claimed_cheque_number || null}, ${claimed_receipt_no || null},
        ${claimed_collector_name || null}, ${proof_document_url || null},
        'Submitted', ${remarks || null}
      )
      RETURNING *
    `;

    return ok(res, complaint, "Missing payment report submitted successfully. Our Accounts desk will investigate.");
  } catch (err) {
    console.error("[Report Missing Error]", err);
    return fail(res, err.message, 500);
  }
});

// ─── 3. CUSTOMER: PLOT PAYMENT DOSSIER (8 Dedicated Tabs) ────────
router.get("/api/plots/:plotId/payment-dossier", userAuth, async (req, res) => {
  try {
    const userId = req.user.user_id || req.user.userId;
    const plotId = req.params.plotId;

    // Fetch booking for this plot & user
    const [booking] = await sql`
      SELECT b.*, p.plot_number, p.plot_area, p.area_unit, p.rate_per_sqft,
             p.base_price, p.plot_status, p.plc_charges,
             s.site_name, s.location as site_location
      FROM bookings b
      JOIN plots p ON p.plot_id = b.plot_id
      JOIN sites s ON s.site_id = p.site_id
      WHERE b.plot_id = ${plotId} AND b.user_id = ${userId}
      ORDER BY b.booking_id DESC LIMIT 1
    `;

    if (!booking) return fail(res, "No active plot booking found for your account", 404);

    const bookingId = booking.booking_id;
    const totalPrice = Number(booking.base_price || (Number(booking.plot_area || 0) * Number(booking.rate_per_sqft || 0)) + Number(booking.plc_charges || 0));

    // 1. Payment Ledger Records
    const ledger = await sql`
      SELECT pl.*, r.receipt_no, pv.voucher_serial
      FROM payment_ledger pl
      LEFT JOIN receipts r ON r.id = pl.receipt_id
      LEFT JOIN payment_vouchers pv ON pv.voucher_id = pl.voucher_id
      WHERE pl.booking_id = ${bookingId}
      ORDER BY pl.payment_date DESC, pl.payment_id DESC
    `;

    // 2. Financial KPIs
    const approvedPaid = ledger
      .filter(p => p.payment_status === "Approved")
      .reduce((sum, p) => sum + Number(p.gross_amount || 0), 0);

    const pendingVerification = ledger
      .filter(p => ["Submitted", "UnderVerification"].includes(p.payment_status))
      .reduce((sum, p) => sum + Number(p.gross_amount || 0), 0);

    const rejectedAmount = ledger
      .filter(p => p.payment_status === "Rejected")
      .reduce((sum, p) => sum + Number(p.gross_amount || 0), 0);

    const bouncedAmount = ledger
      .filter(p => p.payment_status === "Bounced")
      .reduce((sum, p) => sum + Number(p.gross_amount || 0), 0);

    const unpaidBalance = Math.max(0, totalPrice - approvedPaid);
    const progressPct = totalPrice > 0 ? Math.min(100, Math.round((approvedPaid / totalPrice) * 100)) : 0;

    // 3. EMI Schedules with Partial Payment Breakdown
    const emis = await sql`
      SELECT e.*,
             (SELECT json_agg(pa.*) FROM payment_allocations pa WHERE pa.emi_id = e.emi_id) as allocations
      FROM emi_schedules e
      WHERE e.booking_id = ${bookingId}
      ORDER BY e.installment_no ASC
    `;

    const overdueEmis = emis.filter(e => {
      if (e.emi_status === 'Paid') return false;
      return new Date(e.due_date) < new Date();
    });
    const overdueAmount = overdueEmis.reduce((sum, e) => sum + (Number(e.emi_amount) - Number(e.partially_paid_amount || 0) + Number(e.late_fee_amount || 0)), 0);

    const nextPendingEmi = emis.find(e => e.emi_status !== 'Paid');

    // 4. Receipts
    const receipts = await sql`
      SELECT r.* FROM receipts r
      WHERE (r.customer_id = ${userId} AND r.plot_no = ${booking.plot_number})
         OR r.payment_ledger_id IN (SELECT payment_id FROM payment_ledger WHERE booking_id = ${bookingId})
      ORDER BY r.receipt_date DESC, r.id DESC
    `;

    // 5. Vouchers
    const vouchers = await sql`
      SELECT pv.*, e.installment_no, e.due_date, e.emi_amount, e.paid_amount
      FROM payment_vouchers pv
      LEFT JOIN emi_schedules e ON e.emi_id = pv.emi_id
      WHERE pv.booking_id = ${bookingId}
      ORDER BY pv.created_at DESC
    `;

    // 6. Missing Payment Complaints
    const complaints = await sql`
      SELECT * FROM missing_payment_complaints
      WHERE booking_id = ${bookingId}
      ORDER BY created_at DESC
    `;

    // 7. Allocations Breakdown
    const allocations = await sql`
      SELECT pa.*, pl.payment_serial, pl.payment_mode, pl.payment_date
      FROM payment_allocations pa
      JOIN payment_ledger pl ON pl.payment_id = pa.payment_id
      WHERE pa.booking_id = ${bookingId}
      ORDER BY pa.created_at DESC
    `;

    return ok(res, {
      booking,
      summary: {
        total_price: totalPrice,
        approved_paid: approvedPaid,
        pending_verification: pendingVerification,
        rejected_amount: rejectedAmount,
        bounced_amount: bouncedAmount,
        unpaid_balance: unpaidBalance,
        progress_percentage: progressPct,
        overdue_amount: overdueAmount,
        unallocated_advance_balance: Number(booking.unallocated_advance_balance || 0),
        next_emi_amount: nextPendingEmi ? (Number(nextPendingEmi.emi_amount) - Number(nextPendingEmi.partially_paid_amount || 0)) : 0,
        next_emi_due_date: nextPendingEmi?.due_date || null,
        total_emis: emis.length,
        paid_emis: emis.filter(e => e.emi_status === 'Paid').length,
        partially_paid_emis: emis.filter(e => e.emi_status === 'PartiallyPaid').length,
        pending_emis: emis.filter(e => ['Pending', 'ProofSubmitted', 'Overdue'].includes(e.emi_status)).length,
      },
      payment_history: ledger,
      emi_schedule: emis,
      receipts,
      vouchers,
      pending_verifications: ledger.filter(p => ['Submitted', 'UnderVerification'].includes(p.payment_status)),
      excess_advances: allocations.filter(a => a.allocation_type === 'ExcessAdvance'),
      missing_complaints: complaints
    });
  } catch (err) {
    console.error("[Get Plot Dossier Error]", err);
    return fail(res, err.message, 500);
  }
});

// ─── 4. ADMIN: MASTER PAYMENT LEDGER LISTING ───────────────────
router.get("/api/admin/payment-ledger", adminAuth, async (req, res) => {
  try {
    const {
      status,
      mode,
      purpose,
      search,
      site_id,
      start_date,
      end_date,
      page = 1,
      limit = 25
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);

    const rows = await sql`
      SELECT pl.*,
             u.full_name as customer_name, u.mobile_no as customer_mobile, u.member_id,
             p.plot_number, p.plot_area, s.site_name,
             r.receipt_no, pv.voucher_serial,
             adm.full_name as verified_by_name
      FROM payment_ledger pl
      JOIN users u ON u.user_id = pl.user_id
      JOIN plots p ON p.plot_id = pl.plot_id
      JOIN sites s ON s.site_id = pl.site_id
      LEFT JOIN receipts r ON r.id = pl.receipt_id
      LEFT JOIN payment_vouchers pv ON pv.voucher_id = pl.voucher_id
      LEFT JOIN admin_users adm ON adm.admin_id = pl.verified_by_admin_id
      WHERE 1=1
        ${status ? sql`AND pl.payment_status = ${status}` : sql``}
        ${mode ? sql`AND pl.payment_mode = ${mode}` : sql``}
        ${purpose ? sql`AND pl.payment_purpose = ${purpose}` : sql``}
        ${site_id ? sql`AND pl.site_id = ${site_id}` : sql``}
        ${start_date ? sql`AND pl.payment_date >= ${start_date}` : sql``}
        ${end_date ? sql`AND pl.payment_date <= ${end_date}` : sql``}
        ${search ? sql`AND (
          u.full_name ILIKE ${`%${search}%`} OR 
          u.mobile_no ILIKE ${`%${search}%`} OR 
          pl.payment_serial ILIKE ${`%${search}%`} OR 
          pl.utr_number ILIKE ${`%${search}%`} OR 
          p.plot_number ILIKE ${`%${search}%`}
        )` : sql``}
      ORDER BY pl.payment_date DESC, pl.payment_id DESC
      LIMIT ${Number(limit)} OFFSET ${offset}
    `;

    const [totalRow] = await sql`
      SELECT COUNT(*)::int as count,
             SUM(CASE WHEN payment_status = 'Approved' THEN gross_amount ELSE 0 END) as total_approved,
             SUM(CASE WHEN payment_status IN ('Submitted', 'UnderVerification') THEN gross_amount ELSE 0 END) as total_pending
      FROM payment_ledger pl
      JOIN users u ON u.user_id = pl.user_id
      JOIN plots p ON p.plot_id = pl.plot_id
      WHERE 1=1
        ${status ? sql`AND pl.payment_status = ${status}` : sql``}
        ${mode ? sql`AND pl.payment_mode = ${mode}` : sql``}
        ${purpose ? sql`AND pl.payment_purpose = ${purpose}` : sql``}
    `;

    return ok(res, rows, "Payment ledger retrieved", {
      total: totalRow?.count || 0,
      total_approved: totalRow?.total_approved || 0,
      total_pending: totalRow?.total_pending || 0,
      page: Number(page),
      limit: Number(limit)
    });
  } catch (err) {
    console.error("[Admin Payment Ledger Error]", err);
    return fail(res, err.message, 500);
  }
});

// ─── 5. ADMIN: APPROVE PAYMENT & EXECUTE ALLOCATION ───────────
router.post("/api/admin/payments/:id/approve", adminAuth, async (req, res) => {
  try {
    const paymentId = req.params.id;
    const adminId = req.admin?.admin_id || req.admin?.id || 1;

    const [payment] = await sql`
      SELECT * FROM payment_ledger WHERE payment_id = ${paymentId}
    `;
    if (!payment) return fail(res, "Payment not found", 404);

    // Guard: Prevent employee from approving self-submitted cash collection
    if (payment.submitted_by_user_id && String(payment.submitted_by_user_id) === String(adminId) && payment.submitted_by_role === "Admin") {
      return fail(res, "Segregation of Duties Violation: You cannot approve a payment you collected or entered yourself.", 403);
    }

    const result = await executePaymentAllocation(paymentId, adminId);
    return ok(res, result, "Payment approved, ledger allocated, and official receipt generated successfully.");
  } catch (err) {
    console.error("[Admin Approve Payment Error]", err);
    return fail(res, err.message, 500);
  }
});

// ─── 6. ADMIN: REJECT PAYMENT ─────────────────────────────────
router.post("/api/admin/payments/:id/reject", adminAuth, async (req, res) => {
  try {
    const paymentId = req.params.id;
    const adminId = req.admin?.admin_id || req.admin?.id || 1;
    const { rejection_reason } = req.body;

    if (!rejection_reason || !rejection_reason.trim()) {
      return fail(res, "Rejection reason is mandatory", 400);
    }

    const [payment] = await sql`
      SELECT * FROM payment_ledger WHERE payment_id = ${paymentId}
    `;
    if (!payment) return fail(res, "Payment not found", 404);

    await sql`
      UPDATE payment_ledger SET
        payment_status = 'Rejected',
        verification_status = 'Rejected',
        rejection_reason = ${rejection_reason.trim()},
        verified_by_admin_id = ${adminId},
        updated_at = NOW()
      WHERE payment_id = ${paymentId}
    `;

    // If any EMIs were in ProofSubmitted state for this booking, reset to Pending
    await sql`
      UPDATE emi_schedules SET
        emi_status = 'Pending',
        updated_at = NOW()
      WHERE booking_id = ${payment.booking_id} AND emi_status = 'ProofSubmitted'
    `;

    return ok(res, { paymentId }, "Payment rejected successfully");
  } catch (err) {
    console.error("[Admin Reject Payment Error]", err);
    return fail(res, err.message, 500);
  }
});

// ─── 7. ADMIN: CASH COLLECTION REGISTER ────────────────────────
router.post("/api/admin/cash-collections/create", adminAuth, async (req, res) => {
  try {
    const adminId = req.admin?.admin_id || req.admin?.id || 1;
    const {
      collector_user_id,
      customer_id,
      booking_id,
      amount,
      collection_date,
      site_location,
      cash_denomination,
      remarks
    } = req.body;

    const grossAmount = money(amount);
    if (grossAmount <= 0) return fail(res, "Amount must be greater than zero", 400);
    if (!customer_id || !booking_id) return fail(res, "Customer and Booking IDs are required", 400);

    const [booking] = await sql`
      SELECT b.*, p.plot_id, p.site_id FROM bookings b
      JOIN plots p ON p.plot_id = b.plot_id
      WHERE b.booking_id = ${booking_id}
    `;
    if (!booking) return fail(res, "Booking not found", 404);

    const collectionSerial = await generateCashCollectionSerial();

    const [collection] = await sql`
      INSERT INTO cash_collections (
        collection_serial, collector_user_id, customer_id,
        booking_id, plot_id, amount, collection_date, site_location,
        cash_denomination, verification_status, remarks
      ) VALUES (
        ${collectionSerial}, ${collector_user_id || adminId}, ${customer_id},
        ${booking_id}, ${booking.plot_id}, ${grossAmount},
        ${collection_date || new Date().toISOString().split('T')[0]},
        ${site_location || null}, ${cash_denomination ? JSON.stringify(cash_denomination) : null},
        'PendingVerification', ${remarks || null}
      )
      RETURNING *
    `;

    // Also create corresponding payment ledger entry in Submitted state
    const paymentSerial = await generatePaymentSerial();
    await sql`
      INSERT INTO payment_ledger (
        payment_serial, user_id, booking_id, plot_id, site_id,
        payment_mode, payment_purpose, gross_amount, payment_date,
        payment_status, verification_status, cash_collection_id,
        submitted_by_user_id, submitted_by_role, collector_user_id,
        admin_notes
      ) VALUES (
        ${paymentSerial}, ${customer_id}, ${booking_id}, ${booking.plot_id}, ${booking.site_id},
        'Cash', 'EmiPayment', ${grossAmount}, ${collection_date || new Date().toISOString().split('T')[0]},
        'Submitted', 'Pending', ${collection.collection_id},
        ${adminId}, 'Admin', ${collector_user_id || adminId},
        ${`Cash Collection ${collectionSerial}`}
      )
    `;

    return ok(res, collection, "Cash collection recorded successfully");
  } catch (err) {
    console.error("[Cash Collection Create Error]", err);
    return fail(res, err.message, 500);
  }
});

router.get("/api/admin/cash-collections", adminAuth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT cc.*,
             u.full_name as customer_name, u.mobile_no as customer_mobile,
             col.full_name as collector_name,
             p.plot_number, s.site_name
      FROM cash_collections cc
      JOIN users u ON u.user_id = cc.customer_id
      JOIN users col ON col.user_id = cc.collector_user_id
      JOIN plots p ON p.plot_id = cc.plot_id
      JOIN sites s ON s.site_id = p.site_id
      ORDER BY cc.collection_date DESC, cc.collection_id DESC
    `;
    return ok(res, rows, "Cash collections retrieved");
  } catch (err) {
    console.error("[Get Cash Collections Error]", err);
    return fail(res, err.message, 500);
  }
});

// ─── 8. ADMIN: CHEQUE LIFECYCLE MANAGEMENT ─────────────────────
router.get("/api/admin/cheques", adminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const rows = await sql`
      SELECT cq.*,
             u.full_name as customer_name, u.mobile_no as customer_mobile,
             p.plot_number, s.site_name
      FROM cheque_registry cq
      JOIN users u ON u.user_id = cq.customer_id
      JOIN bookings b ON b.booking_id = cq.booking_id
      JOIN plots p ON p.plot_id = b.plot_id
      JOIN sites s ON s.site_id = p.site_id
      WHERE 1=1
        ${status ? sql`AND cq.cheque_status = ${status}` : sql``}
      ORDER BY cq.cheque_date DESC, cq.cheque_id DESC
    `;
    return ok(res, rows, "Cheque registry retrieved");
  } catch (err) {
    console.error("[Get Cheques Error]", err);
    return fail(res, err.message, 500);
  }
});

router.patch("/api/admin/cheques/:id/update-status", adminAuth, async (req, res) => {
  try {
    const chequeId = req.params.id;
    const adminId = req.admin?.admin_id || req.admin?.id || 1;
    const {
      status, // 'Deposited', 'UnderClearing', 'Cleared', 'Bounced', 'Cancelled'
      deposited_date,
      cleared_date,
      bounced_date,
      bounce_reason,
      bounce_penalty_amount,
      deposited_bank_account
    } = req.body;

    const [cheque] = await sql`
      SELECT * FROM cheque_registry WHERE cheque_id = ${chequeId}
    `;
    if (!cheque) return fail(res, "Cheque not found", 404);

    await sql`
      UPDATE cheque_registry SET
        cheque_status = ${status},
        deposited_date = COALESCE(${deposited_date || null}, deposited_date),
        cleared_date = COALESCE(${cleared_date || null}, cleared_date),
        bounced_date = COALESCE(${bounced_date || null}, bounced_date),
        bounce_reason = COALESCE(${bounce_reason || null}, bounce_reason),
        bounce_penalty_amount = COALESCE(${Number(bounce_penalty_amount || 0)}, bounce_penalty_amount),
        deposited_bank_account = COALESCE(${deposited_bank_account || null}, deposited_bank_account),
        verified_by_admin_id = ${adminId},
        updated_at = NOW()
      WHERE cheque_id = ${chequeId}
    `;

    // If Cleared $\rightarrow$ Find corresponding payment_ledger entry and approve it
    if (status === "Cleared") {
      const [payment] = await sql`
        SELECT payment_id FROM payment_ledger WHERE cheque_id = ${chequeId} LIMIT 1
      `;
      if (payment) {
        await executePaymentAllocation(payment.payment_id, adminId);
      }
    }

    // If Bounced $\rightarrow$ Mark payment ledger as Bounced
    if (status === "Bounced") {
      await sql`
        UPDATE payment_ledger SET
          payment_status = 'Bounced',
          verification_status = 'Rejected',
          rejection_reason = ${`Cheque bounced: ${bounce_reason || 'Bank dishonour'}`},
          updated_at = NOW()
        WHERE cheque_id = ${chequeId}
      `;
    }

    return ok(res, { chequeId, status }, `Cheque status updated to ${status}`);
  } catch (err) {
    console.error("[Update Cheque Status Error]", err);
    return fail(res, err.message, 500);
  }
});

// ─── 9. ADMIN: MISSING PAYMENT DISPUTE RESOLUTION ──────────────
router.get("/api/admin/missing-payments", adminAuth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT mpc.*,
             u.full_name as customer_name, u.mobile_no as customer_mobile, u.member_id,
             p.plot_number, s.site_name
      FROM missing_payment_complaints mpc
      JOIN users u ON u.user_id = mpc.user_id
      JOIN plots p ON p.plot_id = mpc.plot_id
      JOIN sites s ON s.site_id = p.site_id
      ORDER BY mpc.created_at DESC
    `;
    return ok(res, rows, "Missing payment complaints retrieved");
  } catch (err) {
    console.error("[Get Missing Complaints Error]", err);
    return fail(res, err.message, 500);
  }
});

router.patch("/api/admin/missing-payments/:id/resolve", adminAuth, async (req, res) => {
  try {
    const complaintId = req.params.id;
    const adminId = req.admin?.admin_id || req.admin?.id || 1;
    const {
      status, // 'ApprovedAndLinked', 'Rejected', 'DuplicateClaim', 'UnderInvestigation'
      investigation_notes,
      create_payment_entry // boolean
    } = req.body;

    const [complaint] = await sql`
      SELECT * FROM missing_payment_complaints WHERE complaint_id = ${complaintId}
    `;
    if (!complaint) return fail(res, "Complaint not found", 404);

    let linkedPaymentId = complaint.linked_payment_id;

    if (status === "ApprovedAndLinked" && create_payment_entry && !linkedPaymentId) {
      const [booking] = await sql`
        SELECT b.*, p.site_id FROM bookings b
        JOIN plots p ON p.plot_id = b.plot_id
        WHERE b.booking_id = ${complaint.booking_id}
      `;

      const paymentSerial = await generatePaymentSerial();
      const [newPayment] = await sql`
        INSERT INTO payment_ledger (
          payment_serial, user_id, booking_id, plot_id, site_id,
          payment_mode, payment_purpose, gross_amount, payment_date,
          payment_status, verification_status, utr_number,
          proof_document_url, admin_notes
        ) VALUES (
          ${paymentSerial}, ${complaint.user_id}, ${complaint.booking_id},
          ${complaint.plot_id}, ${booking.site_id}, ${complaint.claimed_payment_mode},
          'EmiPayment', ${Number(complaint.claimed_amount)}, ${complaint.claimed_payment_date},
          'Submitted', 'Pending', ${complaint.claimed_utr_number || null},
          ${complaint.proof_document_url || null},
          ${`Resolved from dispute ${complaint.complaint_serial}`}
        )
        RETURNING payment_id
      `;

      linkedPaymentId = newPayment.payment_id;
      await executePaymentAllocation(linkedPaymentId, adminId);
    }

    await sql`
      UPDATE missing_payment_complaints SET
        complaint_status = ${status},
        investigation_notes = ${investigation_notes || null},
        resolved_by_admin_id = ${adminId},
        resolved_at = NOW(),
        linked_payment_id = ${linkedPaymentId || null},
        updated_at = NOW()
      WHERE complaint_id = ${complaintId}
    `;

    return ok(res, { complaintId, status, linkedPaymentId }, "Dispute complaint resolved successfully");
  } catch (err) {
    console.error("[Resolve Missing Payment Error]", err);
    return fail(res, err.message, 500);
  }
});

// ─── 10. ADMIN: RECONCILIATION DASHBOARD & MIGRATION TRIGGER ────
router.get("/api/admin/reconciliation/dashboard", adminAuth, async (req, res) => {
  try {
    // Total numbers
    const [stats] = await sql`
      SELECT
        COUNT(*)::int as total_transactions,
        SUM(gross_amount) as total_gross_volume,
        SUM(CASE WHEN payment_status = 'Approved' THEN gross_amount ELSE 0 END) as total_approved_volume,
        SUM(CASE WHEN payment_status = 'Pending' OR payment_status = 'Submitted' THEN gross_amount ELSE 0 END) as total_pending_volume,
        SUM(CASE WHEN payment_status = 'Bounced' THEN gross_amount ELSE 0 END) as total_bounced_volume,
        SUM(excess_unallocated_amount) as total_unallocated_excess,
        COUNT(CASE WHEN payment_status = 'Bounced' THEN 1 END)::int as bounced_count,
        (SELECT COUNT(*)::int FROM missing_payment_complaints WHERE complaint_status = 'Submitted') as pending_complaints_count,
        (SELECT COUNT(*)::int FROM cheque_registry WHERE cheque_status IN ('ChequeReceived', 'Deposited', 'UnderClearing')) as pending_cheques_count
      FROM payment_ledger
    `;

    // Mode-wise collection breakdown
    const modeBreakdown = await sql`
      SELECT payment_mode, COUNT(*)::int as count, SUM(gross_amount) as total_amount
      FROM payment_ledger
      WHERE payment_status = 'Approved'
      GROUP BY payment_mode
      ORDER BY total_amount DESC
    `;

    return ok(res, { stats, mode_breakdown: modeBreakdown }, "Reconciliation dashboard data retrieved");
  } catch (err) {
    console.error("[Reconciliation Dashboard Error]", err);
    return fail(res, err.message, 500);
  }
});

router.post("/api/admin/reconciliation/run-migration", adminAuth, async (req, res) => {
  try {
    const result = await runHistoricalPaymentMigration();
    return ok(res, result, "Historical payment reconciliation migration executed successfully");
  } catch (err) {
    console.error("[Reconciliation Migration Error]", err);
    return fail(res, err.message, 500);
  }
});

export default router;
