import sql from "../db.js";
import bcrypt from "bcryptjs";

async function setAdminPassword() {
  try {
    const newPassword = "MMR@Admin123";
    const email = "admin@mmrconstructions.in";
    console.log(`Setting Admin password for ${email} to: "${newPassword}"...`);

    const hash = await bcrypt.hash(newPassword, 10);

    // Ensure admin_roles exists
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS admin_roles (
        role_id SERIAL PRIMARY KEY,
        role_name TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Ensure SuperAdmin role exists
    await sql.unsafe(`
      INSERT INTO admin_roles (role_id, role_name)
      VALUES (1, 'SuperAdmin')
      ON CONFLICT (role_name) DO NOTHING
    `);

    // Ensure admin_users table exists
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS admin_users (
        admin_id SERIAL PRIMARY KEY,
        role_id INTEGER NOT NULL REFERENCES admin_roles(role_id),
        full_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        is_locked BOOLEAN NOT NULL DEFAULT FALSE,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Upsert admin user
    const updated = await sql`
      INSERT INTO admin_users (role_id, full_name, email, password_hash, is_active, is_locked, failed_login_attempts)
      VALUES (1, 'MMR Admin', ${email}, ${hash}, true, false, 0)
      ON CONFLICT (email) DO UPDATE SET
        password_hash = ${hash},
        is_active = true,
        is_locked = false,
        failed_login_attempts = 0,
        updated_at = NOW()
      RETURNING admin_id, full_name, email`;

    console.log("-----------------------------------------------------");
    console.log("SUCCESS! Admin Account & Password Updated Successfully.");
    console.log("Updated Accounts:");
    updated.forEach(u => console.log(`  - ${u.full_name} (${u.email})`));
    console.log(`\nAdmin Email: ${email}`);
    console.log(`Admin Password: ${newPassword}`);
    console.log("-----------------------------------------------------");
    process.exit(0);
  } catch (error) {
    console.error("FATAL: Failed to update admin password:", error);
    process.exit(1);
  }
}

setAdminPassword();

