import sql from "../db.js";
import bcrypt from "bcryptjs";

async function verifyOrCreateAdminTables() {
  try {
    console.log("=== CHECKING DATABASE FOR admin_users TABLE ===");

    // Check if admin_users exists
    const [tableCheck] = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'admin_users'
      ) as exists;
    `;

    console.log(`admin_users table exists in DB? -> ${tableCheck.exists}`);

    // Ensure admin_roles exists
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS admin_roles (
        role_id SERIAL PRIMARY KEY,
        role_name TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Ensure SuperAdmin role exists
    try {
      await sql.unsafe(`
        INSERT INTO admin_roles (role_id, role_name)
        VALUES (1, 'SuperAdmin')
        ON CONFLICT DO NOTHING
      `);
    } catch {}

    // Ensure admin_users exists
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

    // Ensure admin_sessions exists
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        session_id SERIAL PRIMARY KEY,
        admin_id INTEGER NOT NULL REFERENCES admin_users(admin_id),
        session_token TEXT NOT NULL,
        ip_address TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Create / Update default SuperAdmin account
    const defaultEmail = "admin@mmrconstructions.in";
    const defaultPassword = "MMR@Admin123";
    const passHash = await bcrypt.hash(defaultPassword, 10);

    try {
      let [admin] = await sql`SELECT admin_id, full_name, email FROM admin_users WHERE email = ${defaultEmail}`;
      if (!admin) {
        [admin] = await sql`
          INSERT INTO admin_users (role_id, full_name, email, password_hash, is_active, is_locked, failed_login_attempts)
          VALUES (1, 'MMR Admin', ${defaultEmail}, ${passHash}, TRUE, FALSE, 0)
          RETURNING admin_id, full_name, email`;
      } else {
        await sql`
          UPDATE admin_users SET
            password_hash = ${passHash},
            is_active = TRUE,
            is_locked = FALSE,
            failed_login_attempts = 0,
            updated_at = NOW()
          WHERE email = ${defaultEmail}`;
      }
    } catch (e) {
      console.warn("Admin account setup warning:", e.message);
    }

    // Fetch total admin users count
    const adminCount = await sql`SELECT COUNT(*)::int as count FROM admin_users`;

    console.log("-----------------------------------------------------");
    console.log("SUCCESS! Admin tables & user verified/created successfully.");
    console.log(`Total Admin Users in DB: ${adminCount[0]?.count || 0}`);
    console.log(`Active SuperAdmin Email: ${defaultEmail}`);
    console.log(`Active SuperAdmin Password: ${defaultPassword}`);
    console.log("-----------------------------------------------------");

    process.exit(0);
  } catch (err) {
    console.error("FATAL ERROR verifying/creating admin tables:", err);
    process.exit(1);
  }
}

verifyOrCreateAdminTables();
