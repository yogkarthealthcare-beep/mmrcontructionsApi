import sql from "../db.js";
import bcrypt from "bcryptjs";

async function testAdminLogins() {
  try {
    console.log("-----------------------------------------------------");
    console.log("TESTING ALL ADMIN ACCOUNTS IN DATABASE...");
    console.log("-----------------------------------------------------");

    const admins = await sql`SELECT admin_id, full_name, email, password_hash, is_active, is_locked FROM admin_users`;

    for (const a of admins) {
      console.log(`\nID: ${a.admin_id} | Name: ${a.full_name} | Email: ${a.email}`);
      console.log(`Active: ${a.is_active} | Locked: ${a.is_locked}`);

      // Test passwords: admin123, Admin@123, 123456, admin
      for (const pass of ["admin123", "Admin@123", "123456", "admin", "admin@2026"]) {
        const match = await bcrypt.compare(pass, a.password_hash);
        if (match) {
          console.log(`   ✅ MATCH FOUND! Password is: "${pass}"`);
        }
      }
    }

    console.log("-----------------------------------------------------");
    process.exit(0);
  } catch (e) {
    console.error("Fatal error:", e);
    process.exit(1);
  }
}

testAdminLogins();
