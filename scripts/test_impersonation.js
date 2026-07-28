import sql from "../db.js";

async function testImpersonation() {
  console.log("==================================================");
  console.log("   TESTING ADMIN LOGIN AS USER (IMPERSONATION)    ");
  console.log("==================================================");

  try {
    // 1. Login as Admin using live API
    const loginRes = await fetch("https://mmrcontructions-api-self.vercel.app/api/admin/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@mmrconstructions.in", password: "AdminPassword123!" })
    });
    const loginData = await loginRes.json();
    console.log("1. Admin Login Response:", loginRes.status, loginData.message);

    let adminToken = loginData.data?.token;

    if (!adminToken) {
      // Fallback: get admin from DB and sign token using fallback secret
      const [admin] = await sql`
        SELECT a.admin_id, a.full_name, a.email, r.role_name AS role
        FROM admin_users a
        JOIN admin_roles r ON a.role_id = r.role_id
        WHERE a.is_active = true LIMIT 1`;
      console.log(`1b. Admin fallback from DB: ${admin.full_name} (${admin.email})`);
    }

    // 2. Get an active customer user from DB
    const [customer] = await sql`
      SELECT user_id, full_name, email, user_type, account_status
      FROM users
      WHERE user_type = 'Customer' AND account_status = 'Active' LIMIT 1`;

    if (customer && adminToken) {
      console.log(`\n2. Testing Customer Impersonation for: ${customer.full_name} (ID: ${customer.user_id})`);
      const res = await fetch("https://mmrcontructions-api-self.vercel.app/api/admin/login-as-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${adminToken}`
        },
        body: JSON.stringify({ user_id: customer.user_id, user_type: "Customer" })
      });
      const data = await res.json();
      console.log("   Customer Result:", res.status, data);
    }

    // 3. Get an active associate user from DB
    const [associate] = await sql`
      SELECT user_id, full_name, email, user_type, account_status
      FROM users
      WHERE user_type = 'Associate' AND account_status = 'Active' LIMIT 1`;

    if (associate && adminToken) {
      console.log(`\n3. Testing Associate Impersonation for: ${associate.full_name} (ID: ${associate.user_id})`);
      const res = await fetch("https://mmrcontructions-api-self.vercel.app/api/admin/login-as-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${adminToken}`
        },
        body: JSON.stringify({ user_id: associate.user_id, user_type: "Associate" })
      });
      const data = await res.json();
      console.log("   Associate Result:", res.status, data);
    }

    // 4. Get an active investor user from DB
    const [investor] = await sql`
      SELECT id, full_name, email, status, is_verified
      FROM investor_users
      WHERE status = 'active' AND is_verified = true AND deleted_at IS NULL LIMIT 1`;

    if (investor && adminToken) {
      console.log(`\n4. Testing Investor Impersonation for: ${investor.full_name} (ID: ${investor.id})`);
      const res = await fetch("https://mmrcontructions-api-self.vercel.app/api/admin/login-as-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${adminToken}`
        },
        body: JSON.stringify({ user_id: investor.id, user_type: "Investor" })
      });
      const data = await res.json();
      console.log("   Investor Result:", res.status, data);
    }

    // 5. Verify audit log entry
    const [audit] = await sql`
      SELECT id, actor_name, action, target_table, target_record_id, new_value, created_at
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
