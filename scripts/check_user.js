import sql from "../db.js";

async function checkUser() {
  const targetEmail = 'vikkirock8008@gmail.com';
  console.log(`Checking accounts for: ${targetEmail}`);

  try {
    const usersInMain = await sql`SELECT user_id, full_name, email, mobile_no, user_type, account_status, is_otp_verified, password_hash FROM users WHERE LOWER(email) = ${targetEmail.toLowerCase()}`;
    console.log("\n1. Record in `users` table:", usersInMain);

    const usersInInvestor = await sql`SELECT id, full_name, email, mobile_number, status, is_verified, password_hash, created_at FROM investor_users WHERE LOWER(email) = ${targetEmail.toLowerCase()}`;
    console.log("\n2. Record in `investor_users` table:", usersInInvestor);

    const usersInPending = await sql`SELECT * FROM pending_registrations WHERE LOWER(email) = ${targetEmail.toLowerCase()}`;
    console.log("\n3. Record in `pending_registrations` table:", usersInPending);

  } catch (err) {
    console.error("Database query error:", err);
  } finally {
    process.exit(0);
  }
}

checkUser();
