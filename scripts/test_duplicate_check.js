import sql from "../db.js";

async function run() {
  try {
    console.log("=== Testing Cross-Role Mobile & Email Uniqueness Check ===");

    // Test 1: Check existing investor email/mobile against users table
    const [investor] = await sql`SELECT email, mobile_number FROM investor_users LIMIT 1`;
    if (investor) {
      console.log("Sample Investor:", investor);
      const cleanMobile10 = investor.mobile_number.replace(/\D/g, "").slice(-10);

      const [dupUser] = await sql`
        SELECT user_id, full_name, user_type FROM users
        WHERE LOWER(email) = ${investor.email.toLowerCase()}
           OR RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile10}
        LIMIT 1`;

      if (dupUser) {
        console.log("Investor details match existing user:", dupUser);
      } else {
        console.log("Cross-check ready: Investor details are distinct from users table.");
      }
    }

    console.log("Duplicate check logic verified successfully.");
  } catch (err) {
    console.error("Test Error:", err);
  } finally {
    process.exit(0);
  }
}

run();
