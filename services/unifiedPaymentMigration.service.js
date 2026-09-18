import sql from "../db.js";

/**
 * Unified Payment Migration & Reconciliation Service
 * Safely backfills historical paid EMIs and booking advances into the unified payment ledger
 * without double-counting, without modifying legacy records, and with full idempotency.
 */
export async function runHistoricalPaymentMigration() {
  try {
    console.log("[UnifiedPaymentMigration] Starting historical payment reconciliation...");
    let migratedEmis = 0;
    let migratedAdvances = 0;
    let linkedReceipts = 0;

    // 1. Reconcile Paid EMIs from emi_schedules
    const paidEmis = await sql`
      SELECT e.emi_id, e.booking_id, e.user_id, e.installment_no, e.due_date,
             COALESCE(e.paid_amount, e.emi_amount) as amount,
             e.paid_date, e.late_fee_amount,
             b.plot_id, p.site_id
      FROM emi_schedules e
      JOIN bookings b ON b.booking_id = e.booking_id
      JOIN plots p ON p.plot_id = b.plot_id
      WHERE e.emi_status = 'Paid'
    `;

    for (const emi of paidEmis) {
      const legacyRef = `emi_${emi.emi_id}`;
      const [existing] = await sql`
        SELECT payment_id FROM payment_ledger WHERE legacy_reference = ${legacyRef} LIMIT 1
      `;

      if (!existing) {
        // Fetch voucher if exists
        const [voucher] = await sql`
          SELECT voucher_id FROM payment_vouchers WHERE emi_id = ${emi.emi_id} LIMIT 1
        `;

        const [newPayment] = await sql`
          INSERT INTO payment_ledger (
            payment_serial, user_id, booking_id, plot_id, site_id,
            payment_mode, payment_purpose, gross_amount, late_fee_amount,
            net_allocated_amount, payment_date, payment_status,
            verification_status, voucher_id, legacy_reference
          ) VALUES (
            ${`MMR-LEG-EMI-${String(emi.emi_id).padStart(6, '0')}`},
            ${emi.user_id}, ${emi.booking_id}, ${emi.plot_id}, ${emi.site_id},
            'BankTransfer', 'EmiPayment', ${Number(emi.amount || 0)},
            ${Number(emi.late_fee_amount || 0)}, ${Number(emi.amount || 0)},
            ${emi.paid_date || new Date().toISOString().split('T')[0]},
            'Approved', 'Verified', ${voucher?.voucher_id || null}, ${legacyRef}
          )
          RETURNING payment_id
        `;

        // Insert allocation
        await sql`
          INSERT INTO payment_allocations (
            payment_id, booking_id, allocation_type, emi_id, installment_no, allocated_amount
          ) VALUES (
            ${newPayment.payment_id}, ${emi.booking_id}, 'EmiInstallment',
            ${emi.emi_id}, ${emi.installment_no}, ${Number(emi.amount || 0)}
          )
        `;

        if (voucher?.voucher_id) {
          await sql`
            UPDATE payment_vouchers SET payment_ledger_id = ${newPayment.payment_id}
            WHERE voucher_id = ${voucher.voucher_id}
          `;
        }

        migratedEmis++;
      }
    }

    // 2. Reconcile Confirmed Advance Payments from bookings
    const confirmedBookings = await sql`
      SELECT b.booking_id, b.user_id, b.plot_id, b.advance_amount, b.created_at,
             p.site_id
      FROM bookings b
      JOIN plots p ON p.plot_id = b.plot_id
      WHERE b.booking_status IN ('Confirmed', 'Active')
        AND COALESCE(b.advance_amount, 0) > 0
    `;

    for (const b of confirmedBookings) {
      const legacyRef = `advance_${b.booking_id}`;
      const [existing] = await sql`
        SELECT payment_id FROM payment_ledger WHERE legacy_reference = ${legacyRef} LIMIT 1
      `;

      if (!existing) {
        const [newPayment] = await sql`
          INSERT INTO payment_ledger (
            payment_serial, user_id, booking_id, plot_id, site_id,
            payment_mode, payment_purpose, gross_amount,
            net_allocated_amount, payment_date, payment_status,
            verification_status, legacy_reference
          ) VALUES (
            ${`MMR-LEG-ADV-${String(b.booking_id).padStart(6, '0')}`},
            ${b.user_id}, ${b.booking_id}, ${b.plot_id}, ${b.site_id},
            'BankTransfer', 'BookingAdvance', ${Number(b.advance_amount || 0)},
            ${Number(b.advance_amount || 0)},
            ${b.created_at ? new Date(b.created_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]},
            'Approved', 'Verified', ${legacyRef}
          )
          RETURNING payment_id
        `;

        await sql`
          INSERT INTO payment_allocations (
            payment_id, booking_id, allocation_type, allocated_amount
          ) VALUES (
            ${newPayment.payment_id}, ${b.booking_id}, 'BookingAdvance', ${Number(b.advance_amount || 0)}
          )
        `;

        migratedAdvances++;
      }
    }

    // 3. Link Existing Receipts to Payment Ledger
    const unlinkedReceipts = await sql`
      SELECT r.id, r.customer_id, r.plot_no, r.paid_amount, r.receipt_date
      FROM receipts r
      WHERE r.payment_ledger_id IS NULL AND r.status = 'Active'
    `;

    for (const r of unlinkedReceipts) {
      // Find matching payment ledger row
      const [match] = await sql`
        SELECT pl.payment_id
        FROM payment_ledger pl
        LEFT JOIN plots p ON p.plot_id = pl.plot_id
        WHERE pl.user_id = ${r.customer_id}
          AND (COALESCE(pl.plot_number, p.plot_number, '') = ${r.plot_no})
          AND ABS(pl.gross_amount - ${Number(r.paid_amount || 0)}) < 0.01
          AND pl.receipt_id IS NULL
        LIMIT 1
      `;

      if (match) {
        await sql`
          UPDATE payment_ledger SET receipt_id = ${r.id} WHERE payment_id = ${match.payment_id}
        `;
        await sql`
          UPDATE receipts SET payment_ledger_id = ${match.payment_id} WHERE id = ${r.id}
        `;
        linkedReceipts++;
      }
    }

    console.log(`[UnifiedPaymentMigration] Completed: ${migratedEmis} EMIs backfilled, ${migratedAdvances} advances backfilled, ${linkedReceipts} receipts linked.`);
    return {
      success: true,
      migratedEmis,
      migratedAdvances,
      linkedReceipts
    };
  } catch (err) {
    console.error("[UnifiedPaymentMigration] Error during migration:", err);
    return { success: false, error: err.message };
  }
}
