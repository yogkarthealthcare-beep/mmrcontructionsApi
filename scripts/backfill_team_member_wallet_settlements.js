import sql from "../db.js";

/**
 * MMR Construction & Developers Pvt. Ltd.
 * STANDALONE BACKFILL SCRIPT (DO NOT AUTO-RUN - REVIEW BEFORE EXECUTION)
 * 
 * Purpose:
 * Scans historical plot order settlements that were marked 'Released' where
 * a seller or recipient was a Team Member, and verifies/backfills:
 * 1. user_wallets balance & total_commission
 * 2. wallet_transactions credit ledger record
 * 3. Idempotency guarantees: Does not duplicate if already credited.
 */

export async function previewBackfill(dbInstance = sql) {
  console.log("=== PREVIEWING TEAM MEMBER SETTLEMENT BACKFILL ===");

  // Find all plot_order_settlements where recipient_breakdown contains Team Members
  const settlements = await dbInstance`
    SELECT pos.settlement_id, pos.booking_id, pos.settlement_reference,
           pos.total_plot_price, pos.amount_received, pos.recipient_breakdown,
           pos.created_at, b.booking_serial, b.sold_by_user_id
    FROM plot_order_settlements pos
    JOIN bookings b ON b.booking_id = pos.booking_id
    WHERE pos.new_status = 'Released'
    ORDER BY pos.settlement_id ASC
  `;

  console.log(`Found ${settlements.length} total released settlements to inspect.`);

  const candidateCredits = [];

  for (const stl of settlements) {
    const recipients = Array.isArray(stl.recipient_breakdown) ? stl.recipient_breakdown : [];
    for (const rec of recipients) {
      if (rec.user_id && rec.amount > 0 && (rec.user_type === 'Team Member' || rec.role?.includes('Team Member') || rec.role === 'TeamMember')) {
        // Check if wallet_transactions already has this settlement credit
        const [existingTx] = await dbInstance`
          SELECT id FROM wallet_transactions
          WHERE user_id = ${rec.user_id}
            AND payment_order_id = ${stl.settlement_reference}
            AND transaction_type = 'credit'
          LIMIT 1
        `;

        candidateCredits.push({
          settlement_id: stl.settlement_id,
          settlement_reference: stl.settlement_reference,
          booking_id: stl.booking_id,
          booking_serial: stl.booking_serial,
          user_id: rec.user_id,
          name: rec.name,
          amount: Number(rec.amount),
          already_credited: Boolean(existingTx)
        });
      }
    }
  }

  console.table(candidateCredits);
  return candidateCredits;
}

export async function executeBackfill(dbInstance = sql) {
  console.log("=== EXECUTING TEAM MEMBER SETTLEMENT BACKFILL ===");
  const candidates = await previewBackfill(dbInstance);
  const toProcess = candidates.filter(c => !c.already_credited);

  if (toProcess.length === 0) {
    console.log("No pending backfills needed. All settlements are up to date!");
    return { backfilled_count: 0 };
  }

  let backfilledCount = 0;

  for (const item of toProcess) {
    await dbInstance.begin(async (tx) => {
      // 1. Get or create wallet
      let [wallet] = await tx`
        SELECT * FROM user_wallets WHERE user_id = ${item.user_id} FOR UPDATE
      `;

      if (!wallet) {
        [wallet] = await tx`
          INSERT INTO user_wallets (user_id, user_role, available_balance, total_commission)
          VALUES (${item.user_id}, 'Team Member', ${item.amount}, ${item.amount})
          RETURNING *
        `;
      } else {
        const newAvailable = Number(wallet.available_balance) + item.amount;
        const newCommission = Number(wallet.total_commission) + item.amount;
        [wallet] = await tx`
          UPDATE user_wallets SET
            available_balance = ${newAvailable},
            total_commission = ${newCommission},
            updated_at = NOW()
          WHERE id = ${wallet.id}
          RETURNING *
        `;
      }

      const balanceBefore = Number(wallet.available_balance) - item.amount;
      const balanceAfter = Number(wallet.available_balance);

      // 2. Insert wallet_transaction ledger
      await tx`
        INSERT INTO wallet_transactions (
          wallet_id, user_id, user_role, transaction_type, source,
          amount, balance_before, balance_after, payment_order_id,
          status, remarks, created_at
        ) VALUES (
          ${wallet.id}, ${item.user_id}, 'Team Member',
          'credit', 'Commission Settlement (Backfill)', ${item.amount},
          ${balanceBefore}, ${balanceAfter}, ${item.settlement_reference},
          'success', ${'Backfilled commission settlement for Booking #' + (item.booking_serial || item.booking_id)}, NOW()
        )
      `;

      backfilledCount++;
    });
  }

  console.log(`Successfully backfilled ${backfilledCount} team member settlement credits.`);
  return { backfilled_count: backfilledCount };
}

if (process.argv[1]?.endsWith("backfill_team_member_wallet_settlements.js")) {
  previewBackfill()
    .then(() => {
      console.log("\nNOTE: This script is in PREVIEW mode. To execute backfill, call executeBackfill() after review.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Backfill check error:", err);
      process.exit(1);
    });
}
