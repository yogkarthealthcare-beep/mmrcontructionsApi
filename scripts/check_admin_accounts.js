import sql from "../db.js";

async function checkAdmins() {
  try {
    console.log("=== CHECKING admin_users TABLE ===");
    const adminUsers = await sql`SELECT admin_id, full_name, email, is_active, is_locked FROM admin_users`;
    console.log("admin_users count:", adminUsers.length);
    console.log("admin_users rows:", adminUsers);

    console.log("\n=== CHECKING users TABLE (Admin/SuperAdmin) ===");
    const usersAdmin = await sql`SELECT user_id, full_name, email, user_type FROM users WHERE LOWER(COALESCE(email, '')) LIKE '%admin%' OR user_type IN ('Admin', 'SuperAdmin')`;
    console.log("users table count:", usersAdmin.length);
    console.log("users table rows:", usersAdmin);

    process.exit(0);
  } catch (e) {
    console.error("Error checking admins:", e);
    process.exit(1);
  }
}

checkAdmins();
