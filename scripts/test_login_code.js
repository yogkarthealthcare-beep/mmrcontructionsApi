import sql from "../db.js";
import bcrypt from "bcryptjs";

async function testLogin() {
  try {
    const identifier = "vikkirock8008@gmail.com";
    const password = "TestPass123!";

    const loginId = String(identifier || "").trim().toLowerCase();
    const loginEmail = loginId.includes("@") ? loginId : null;
    const loginMobile = loginId.replace(/\D/g, "");
    const cleanMobile = loginMobile.length >= 10 ? loginMobile.slice(-10) : (loginMobile || null);

    console.log("loginId:", loginId);
    console.log("loginEmail:", loginEmail);
    console.log("cleanMobile:", cleanMobile);

    let [user] = loginEmail
      ? await sql`
          SELECT user_id, full_name, email, mobile_no, user_type, account_status,
                 member_id, invitation_code, password_hash, email_verified, is_otp_verified
          FROM users
          WHERE LOWER(email) = ${loginEmail}`
      : (cleanMobile ? await sql`
          SELECT user_id, full_name, email, mobile_no, user_type, account_status,
                 member_id, invitation_code, password_hash, email_verified, is_otp_verified
          FROM users
          WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile}` : []);

    console.log("Found in `users`:", user);

    if (!user) {
      const [investor] = loginEmail
        ? await sql`SELECT id, full_name, email, mobile_number, password_hash, status, is_verified FROM investor_users WHERE LOWER(email) = ${loginEmail} AND deleted_at IS NULL LIMIT 1`
        : (cleanMobile ? await sql`SELECT id, full_name, email, mobile_number, password_hash, status, is_verified FROM investor_users WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${cleanMobile} AND deleted_at IS NULL LIMIT 1` : []);

      console.log("Found in `investor_users`:", investor);

      if (investor) {
        const valid = await bcrypt.compare(password, investor.password_hash);
        console.log("Password valid?:", valid);
      }
    }
  } catch (e) {
    console.error("EXACT ERROR THROWN:", e);
  } finally {
    process.exit(0);
  }
}

testLogin();
