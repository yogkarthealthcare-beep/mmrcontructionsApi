import sql from "../db.js";
import bcrypt from "bcryptjs";

async function resetAdminPass() {
  try {
    const defaultPass = "MMR@Admin123";
    const passHash = await bcrypt.hash(defaultPass, 10);

    // Update admin@mmrconstructions.in password to admin123
    await sql`
      UPDATE admin_users 
      SET password_hash = ${passHash}, is_active = true, is_locked = false, failed_login_attempts = 0
      WHERE LOWER(email) IN ('admin@mmrconstructions.in', 'admin@mmrconstructions.com')`;

    console.log("-----------------------------------------------------");
    console.log("Admin Passwords Reset Successfully!");
    console.log("Email: admin@mmrconstructions.in");
    console.log("Password: MMR@Admin123");
    console.log("-----------------------------------------------------");
    process.exit(0);
  } catch (e) {
    console.error("Error resetting admin pass:", e);
    process.exit(1);
  }
}

resetAdminPass();
