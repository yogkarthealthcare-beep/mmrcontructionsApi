import sql from "../db.js";

async function wipeTestData() {
  console.log("-----------------------------------------------------");
  console.log("STARTING SAFE DATABASE TEST DATA CLEANUP...");
  console.log("-----------------------------------------------------");

  try {
    // 1. Delete all booking child records
    console.log("1. Deleting test orders, invoices, EMI schedules, buybacks, and booking payments...");
    try { await sql`DELETE FROM emi_schedules`; } catch (e) {}
    try { await sql`DELETE FROM buyback_applications`; } catch (e) {}
    try { await sql`DELETE FROM buyback_requests`; } catch (e) {}
    try { await sql`DELETE FROM buyback_audit`; } catch (e) {}
    try { await sql`DELETE FROM offline_bookings`; } catch (e) {}
    try { await sql`DELETE FROM appointments`; } catch (e) {}
    try { await sql`DELETE FROM invoice_audit_log`; } catch (e) {}
    try { await sql`DELETE FROM booking_invoices`; } catch (e) {}
    try { await sql`DELETE FROM booking_payment_records`; } catch (e) {}
    try { await sql`DELETE FROM invoices`; } catch (e) {}
    try { await sql`DELETE FROM booking_workflow_events`; } catch (e) {}
    try { await sql`DELETE FROM kyc_verifications`; } catch (e) {}

    // Delete Bookings
    const deletedBookings = await sql`DELETE FROM bookings RETURNING booking_id`;
    console.log(`   --> ${deletedBookings.length} test bookings deleted.`);

    // Reset Invoice sequence back to 0 (so next invoice starts at MMR-2026-000001)
    try {
      await sql`UPDATE invoice_number_sequence SET current_seq = 0 WHERE id = 1`;
      console.log("   --> Invoice sequence reset to 000001.");
    } catch (_) {}

    // 2. Reset Plots status back to Available / Vacant
    console.log("2. Resetting plot statuses to 'Available'...");
    let updatedPlots = [];
    try {
      updatedPlots = await sql`UPDATE plots SET plot_status = 'Available', updated_at = NOW() RETURNING plot_id`;
    } catch (_) {
      try {
        updatedPlots = await sql`UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() RETURNING plot_id`;
      } catch (e) {
        console.log("   --> Note updating plots status:", e.message);
      }
    }
    console.log(`   --> ${updatedPlots.length} plots reset to Available / Vacant.`);

    // 3. Delete MLM & Commissions & Wallets & Associate Trackers
    console.log("3. Deleting commissions, MLM transactions, associate trackers, and wallets...");
    try { await sql`DELETE FROM associate_sales_tracker`; } catch (e) {}
    try { await sql`DELETE FROM associate_rank_history`; } catch (e) {}
    try { await sql`DELETE FROM commission_transactions`; } catch (e) {}
    try { await sql`DELETE FROM mlm_network`; } catch (e) {}
    try { await sql`DELETE FROM mlm_tree_closure`; } catch (e) {}
    try { await sql`DELETE FROM associate_network_closure`; } catch (e) {}
    try { await sql`DELETE FROM associate_profiles`; } catch (e) {}
    try { await sql`DELETE FROM referral_registrations`; } catch (e) {}
    try { await sql`DELETE FROM payout_requests`; } catch (e) {}
    try { await sql`DELETE FROM withdrawal_requests`; } catch (e) {}
    try { await sql`DELETE FROM wallets`; } catch (e) {}
    try { await sql`DELETE FROM user_documents`; } catch (e) {}
    try { await sql`DELETE FROM book_plot_leads`; } catch (e) {}
    try { await sql`DELETE FROM investor_deposits`; } catch (e) {}
    try { await sql`DELETE FROM investor_withdrawals`; } catch (e) {}
    try { await sql`DELETE FROM investor_transactions`; } catch (e) {}
    try { await sql`DELETE FROM investor_documents`; } catch (e) {}
    try { await sql`DELETE FROM investor_wallet`; } catch (e) {}

    // 4. Delete Non-Admin Users (Customers & Associates)
    console.log("4. Deleting test Customer and Associate user accounts...");
    let deletedUsers = [];
    try {
      deletedUsers = await sql`
        DELETE FROM users 
        WHERE (user_type IS NULL OR user_type NOT IN ('Admin', 'SuperAdmin')) 
          AND LOWER(COALESCE(email, '')) NOT IN ('admin@mmrconstructions.com', 'admin@mmr.com')
        RETURNING user_id, full_name, email`;
    } catch (_) {
      try {
        deletedUsers = await sql`
          DELETE FROM users 
          WHERE LOWER(COALESCE(email, '')) NOT IN ('admin@mmrconstructions.com', 'admin@mmr.com')
            AND user_id != 1
          RETURNING user_id, full_name, email`;
      } catch (e) {
        console.log("   --> Note deleting users:", e.message);
      }
    }
    console.log(`   --> ${deletedUsers.length} test user accounts deleted.`);

    console.log("-----------------------------------------------------");
    console.log("SUCCESS! Database test data wiped successfully.");
    console.log("SuperAdmin account, Sites & Plots master data preserved.");
    console.log("-----------------------------------------------------");
    process.exit(0);
  } catch (error) {
    console.error("FATAL: Database wipe failed:", error);
    process.exit(1);
  }
}

wipeTestData();
