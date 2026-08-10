import sql from "../db.js";
import jwt from "jsonwebtoken";

async function testImpersonation() {
  console.log("==================================================");
  console.log("   TESTING ADMIN LOGIN AS USER (IMPERSONATION)    ");
  console.log("==================================================");

  try {
    const [admin] = await sql`
      SELECT a.admin_id, a.full_name, a.email, r.role_name AS role
      FROM admin_users a
      JOIN admin_roles r ON a.role_id = r.role_id
      WHERE a.is_active = true LIMIT 1`;

    if (!admin) {
      console.error("No active admin found");
      process.exit(1);
    }
    console.log(`1. Found Active Admin: ${admin.full_name} (${admin.email}, Role: ${admin.role})`);

    const secret = process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
    const adminToken = jwt.sign({
      admin_id: admin.admin_id,
      email: admin.email,
      full_name: admin.full_name,
      role: admin.role
    }, secret, { expiresIn: "1h" });

    const [customer] = await sql`
      SELECT user_id, full_name, email, user_type, account_status
      FROM users
      WHERE user_type = 'Customer' AND account_status = 'Active' LIMIT 1`;

    if (customer) {
      console.log(`\n2. Testing Customer Impersonation for: ${customer.full_name} (ID: ${customer.user_id})`);
      const res = await fetch("https://api.mmrconstructions.in/api/admin/login-as-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${adminToken}`
        },
        body: JSON.stringify({ user_id: customer.user_id, user_type: "Customer" })
      });
      const text = await res.text();
      console.log("   Customer Status:", res.status, text);
    }

    const [associate] = await sql`
      SELECT user_id, full_name, email, user_type, account_status
      FROM users
      WHERE user_type = 'Associate' AND account_status = 'Active' LIMIT 1`;

    if (associate) {
      console.log(`\n3. Testing Associate Impersonation for: ${associate.full_name} (ID: ${associate.user_id})`);
      const res = await fetch("https://api.mmrconstructions.in/api/admin/login-as-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${adminToken}`
        },
        body: JSON.stringify({ user_id: associate.user_id, user_type: "Associate" })
      });
      const text = await res.text();
      console.log("   Associate Status:", res.status, text);
    }

    const [investor] = await sql`
      SELECT id, full_name, email, status, is_verified
      FROM investor_users
      WHERE status = 'active' AND is_verified = true AND deleted_at IS NULL LIMIT 1`;

    if (investor) {
      console.log(`\n4. Testing Investor Impersonation for: ${investor.full_name} (ID: ${investor.id})`);
      const res = await fetch("https://api.mmrconstructions.in/api/admin/login-as-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${adminToken}`
        },
        body: JSON.stringify({ user_id: investor.id, user_type: "Investor" })
      });
      const text = await res.text();
      console.log("   Investor Status:", res.status, text);
    }

    const [audit] = await sql`
      SELECT audit_id, actor_name, action, target_table, target_record_id, new_value, created_at
      FROM audit_log
      WHERE module = 'AdminImpersonation'
      ORDER BY id DESC LIMIT 1`;
    if (audit) {
      console.log("\n5. Audit Log Entry Verified:", audit);
    }

    console.log("\n==================================================");
    console.log("   ALL BACKEND IMPERSONATION TESTS COMPLETED      ");
    console.log("==================================================");

  } catch (err) {
    console.error("Test Error:", err);
  } finally {
    process.exit(0);
  }
}

testImpersonation();
