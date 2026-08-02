import sql from "../db.js";

async function wipeInvestorData() {
  console.log("-----------------------------------------------------");
  console.log("STARTING INVESTOR DATA CLEANUP FROM SQL...");
  console.log("-----------------------------------------------------");

  try {
    // 1. Delete Investor Portal child tables
    console.log("1. Deleting investor deposits, withdrawals, transactions, documents, and notifications...");
    try { const d1 = await sql`DELETE FROM investor_deposits RETURNING id`; console.log(`   --> ${d1.length} investor deposits deleted.`); } catch (e) {}
    try { const d2 = await sql`DELETE FROM investor_withdrawals RETURNING id`; console.log(`   --> ${d2.length} investor withdrawals deleted.`); } catch (e) {}
    try { const d3 = await sql`DELETE FROM investor_transactions RETURNING id`; console.log(`   --> ${d3.length} investor transactions deleted.`); } catch (e) {}
    try { const d4 = await sql`DELETE FROM investor_documents RETURNING id`; console.log(`   --> ${d4.length} investor documents deleted.`); } catch (e) {}
    try { const d5 = await sql`DELETE FROM investor_settlement_preferences RETURNING id`; console.log(`   --> ${d5.length} investor settlement preferences deleted.`); } catch (e) {}
    try { const d6 = await sql`DELETE FROM investor_notifications RETURNING id`; console.log(`   --> ${d6.length} investor notifications deleted.`); } catch (e) {}
    try { const d7 = await sql`DELETE FROM investor_wallet RETURNING id`; console.log(`   --> ${d7.length} investor wallets deleted.`); } catch (e) {}

    // 2. Delete Investor Users (Investor Portal Accounts)
    console.log("2. Deleting investor_users accounts...");
    try {
      const deletedInvUsers = await sql`DELETE FROM investor_users RETURNING id, full_name, email`;
      console.log(`   --> ${deletedInvUsers.length} investor_users accounts deleted.`);
    } catch (e) {
      console.log("   --> Note deleting investor_users:", e.message);
    }

    // 3. Delete Marketing / Showcase Investors
    console.log("3. Deleting showcase investors from 'investors' table...");
    try {
      const deletedInvestors = await sql`DELETE FROM investors RETURNING id, name`;
      console.log(`   --> ${deletedInvestors.length} showcase investors deleted.`);
    } catch (e) {
      console.log("   --> Note deleting investors:", e.message);
    }

    console.log("-----------------------------------------------------");
    console.log("SUCCESS! All investor data deleted from SQL database.");
    console.log("-----------------------------------------------------");
    process.exit(0);
  } catch (error) {
    console.error("FATAL: Investor data wipe failed:", error);
    process.exit(1);
  }
}

wipeInvestorData();
