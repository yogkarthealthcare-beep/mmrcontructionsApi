import sql from "../db.js";
import bcrypt from "bcryptjs";

async function setAdminPassword() {
  try {
    const newPassword = "MMR@Admin123";
    console.log(`Setting Admin password to: "${newPassword}"...`);

    const hash = await bcrypt.hash(newPassword, 10);

    const updated = await sql`
      UPDATE admin_users 
      SET password_hash = ${hash},
          is_active = true,
          is_locked = false,
          failed_login_attempts = 0
      WHERE LOWER(email) IN ('admin@mmrconstructions.in', 'admin@mmrconstructions.com', 'rizwan@mmrconstructions.com')
      RETURNING admin_id, full_name, email`;

    console.log("-----------------------------------------------------");
    console.log("SUCCESS! Admin Password Updated Successfully.");
    console.log("Updated Accounts:");
    updated.forEach(u => console.log(`  - ${u.full_name} (${u.email})`));
    console.log(`\nNew Admin Password: ${newPassword}`);
    console.log("-----------------------------------------------------");
    process.exit(0);
  } catch (error) {
    console.error("FATAL: Failed to update admin password:", error);
    process.exit(1);
  }
}

setAdminPassword();
