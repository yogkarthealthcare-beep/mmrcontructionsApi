import sql from '../db.js';

async function check() {
  try {
    console.log("=== CHECKING test13@gmail.com IN DATABASE ===");

    const pending = await sql`SELECT * FROM pending_registrations WHERE LOWER(email) LIKE '%test13%' OR mobile_no LIKE '%test13%'`;
    console.log("Pending registrations:", pending);

    const investorUsers = await sql`SELECT id, full_name, email, mobile_number, status, is_verified, created_at FROM investor_users WHERE LOWER(email) LIKE '%test13%' OR mobile_number LIKE '%test13%'`;
    console.log("Investor users:", investorUsers);

    const users = await sql`SELECT user_id, full_name, email, mobile_no, role, is_active, created_at FROM users WHERE LOWER(email) LIKE '%test13%' OR mobile_no LIKE '%test13%'`;
    console.log("General users:", users);

    const allInvestors = await sql`SELECT id, full_name, email, mobile_number, status, is_verified FROM investor_users ORDER BY id DESC LIMIT 5`;
    console.log("Latest 5 investor_users:", allInvestors);

    const allUsers = await sql`SELECT user_id, full_name, email, mobile_no, role FROM users ORDER BY user_id DESC LIMIT 5`;
    console.log("Latest 5 users:", allUsers);

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

check();
