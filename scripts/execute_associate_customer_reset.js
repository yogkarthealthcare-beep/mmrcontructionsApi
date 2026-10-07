import sql from "../db.js";
import bcrypt from "bcryptjs";

async function runReset() {
  console.log("==================================================================");
  console.log("MMR CONSTRUCTIONS — FRESH DATABASE RESET (ASSOCIATE & CUSTOMER)");
  console.log("==================================================================\n");

  const tablesToTruncate = [
    'associate_address',
    'associate_bank_details',
    'associate_nominee',
    'associate_sponsor',
    'associate_sales_tracker',
    'associate_rank_history',
    'associate_referral_links',
    'associate_payouts',
    'customer_nominees',
    'customer_enrollment_submissions',
    'user_addresses',
    'user_bank_details',
    'user_nominees',
    'user_kyc_profiles',
    'user_documents',
    'user_device_tokens',
    'wallet_transactions',
    'wallets',
    'payout_requests',
    'kyc_requests',
    'bank_account_verification',
    'otp_log',
    'associate_enrollment',
    'team_members'
  ];

  try {
    // 1. Check existing table existence
    console.log("1. Checking table existence and current row counts...");
    for (const table of tablesToTruncate) {
      try {
        const [res] = await sql.unsafe(`SELECT count(*)::int AS cnt FROM ${table}`);
        console.log(`   - ${table}: ${res.cnt} rows`);
      } catch (e) {
        console.log(`   - ${table}: [Not present or error: ${e.message}]`);
      }
    }

    const [userCount] = await sql`SELECT count(*)::int AS cnt FROM users`;
    console.log(`   - users: ${userCount.cnt} total users`);

    // 2. Perform safe truncate of child tables
    console.log("\n2. Truncating Associate & Customer data tables...");
    for (const table of tablesToTruncate) {
      try {
        await sql.unsafe(`TRUNCATE TABLE ${table} CASCADE`);
        console.log(`   ✅ Truncated: ${table}`);
      } catch (e) {
        console.warn(`   ⚠️ Warning truncating ${table}: ${e.message}`);
      }
    }

    // 3. Clean users table (delete all users > 1, preserving root admin/company account)
    console.log("\n3. Cleaning users table (preserving User ID = 1 / MMR00001)...");
    const deletedUsers = await sql`DELETE FROM users WHERE user_id > 1 RETURNING user_id, member_id, full_name, user_type`;
    console.log(`   ✅ Deleted ${deletedUsers.length} secondary user accounts.`);

    // 4. Ensure Root Admin (User ID = 1 / MMR00001) exists and is Active
    console.log("\n4. Ensuring Root Admin account (User ID = 1 / MMR00001 / MMR0001)...");
    const rawPassword = "Mmr@2026";
    const passwordHash = await bcrypt.hash(rawPassword, 12);
    const email = "mmrconstructions@hotmail.com";
    const mobile_no = "7071951011";
    const full_name = "Suraj Kumar Verma";
    const member_id = "MMR00001";
    const invitation_code = "MMR0001";

    await sql`
      INSERT INTO users (
        user_id, member_id, full_name, email, mobile_no,
        user_type, account_status, invitation_code,
        password_hash, is_active, is_verified, email_verified, is_otp_verified, registered_at
      ) VALUES (
        1, ${member_id}, ${full_name}, ${email.toLowerCase()}, ${mobile_no},
        'Admin', 'Active', ${invitation_code},
        ${passwordHash}, TRUE, TRUE, TRUE, TRUE, NOW()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        member_id = ${member_id},
        full_name = ${full_name},
        email = ${email.toLowerCase()},
        mobile_no = ${mobile_no},
        user_type = 'Admin',
        account_status = 'Active',
        invitation_code = ${invitation_code},
        password_hash = ${passwordHash},
        is_active = TRUE,
        is_verified = TRUE,
        email_verified = TRUE,
        is_otp_verified = TRUE,
        updated_at = NOW()
    `;
    console.log("   ✅ Root Admin ensured: Suraj Kumar Verma (ID: 1, Member ID: MMR00001, Sponsor Code: MMR0001)");

    // 5. Reset Sequences
    console.log("\n5. Resetting auto-increment sequences...");
    try {
      await sql`SELECT setval('users_user_id_seq', (SELECT COALESCE(MAX(user_id), 1) FROM users))`;
      console.log("   ✅ users_user_id_seq reset to 1");
    } catch (e) {
      console.warn("   ⚠️ Sequence reset warning (users_user_id_seq):", e.message);
    }

    try {
      await sql`SELECT setval(pg_get_serial_sequence('associate_enrollment', 'id'), 1, false)`;
      console.log("   ✅ associate_enrollment id sequence reset to 1");
    } catch (e) {
      console.warn("   ⚠️ Sequence reset warning (associate_enrollment):", e.message);
    }

    console.log("\n==================================================================");
    console.log("DATABASE RESET COMPLETE: READY FOR FRESH REGISTRATIONS!");
    console.log("Next new Associate will register under Sponsor MMR0001 and receive Member ID MMR00002");
    console.log("==================================================================");

  } catch (err) {
    console.error("FATAL ERROR DURING RESET:", err);
  } finally {
    process.exit(0);
  }
}

runReset();
