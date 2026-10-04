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

    // Ensure invoice_audit_log sequence and default
    try {
      await sql.unsafe(`
        CREATE SEQUENCE IF NOT EXISTS invoice_audit_log_log_id_seq;
        ALTER TABLE invoice_audit_log ALTER COLUMN log_id SET DEFAULT nextval('invoice_audit_log_log_id_seq');
      `);
    } catch (e) {
      console.warn("invoice_audit_log sequence setup notice:", e.message);
    }

    // Auto-repair all primary key sequences across database tables
    try {
      console.log("=== SYNCHRONIZING ALL DATABASE SEQUENCES ===");
      await sql.unsafe(`
        DO $$
        DECLARE
          r RECORD;
          max_val BIGINT;
        BEGIN
          FOR r IN (
            SELECT 
              c.table_name,
              c.column_name,
              pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) AS sequence_name
            FROM information_schema.columns c
            JOIN information_schema.tables t 
              ON t.table_name = c.table_name AND t.table_schema = c.table_schema
            WHERE c.table_schema = 'public' 
              AND t.table_type = 'BASE TABLE'
              AND pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) IS NOT NULL
          ) LOOP
            BEGIN
              EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM %I', r.column_name, r.table_name) INTO max_val;
              IF max_val > 0 THEN
                EXECUTE format('SELECT setval(%L, %s, true)', r.sequence_name, max_val);
              END IF;
            EXCEPTION WHEN OTHERS THEN
              NULL;
            END;
          END LOOP;
        END $$;
      `);

      // Specifically ensure plot_status_history and core table sequences
      await sql.unsafe(`
        DO $$
        DECLARE
          seq_name TEXT;
          max_id BIGINT;
        BEGIN
          SELECT pg_get_serial_sequence('plot_status_history', 'history_id') INTO seq_name;
          IF seq_name IS NULL THEN
            SELECT pg_get_serial_sequence('plot_status_history', 'id') INTO seq_name;
          END IF;
          IF seq_name IS NULL THEN
            SELECT c.relname FROM pg_class c WHERE c.relkind = 'S' AND c.relname LIKE 'plot_status_history%' LIMIT 1 INTO seq_name;
          END IF;
          IF seq_name IS NOT NULL THEN
            BEGIN
              SELECT COALESCE(MAX(history_id), 0) FROM plot_status_history INTO max_id;
            EXCEPTION WHEN OTHERS THEN
              BEGIN
                SELECT COALESCE(MAX(id), 0) FROM plot_status_history INTO max_id;
              EXCEPTION WHEN OTHERS THEN
                max_id := 0;
              END;
            END;
            IF max_id > 0 THEN
              PERFORM setval(seq_name, max_id, true);
            END IF;
          END IF;
        END $$;
      `);
      console.log("Database sequences synchronized successfully ✅");
    } catch (seqErr) {
      console.warn("Sequence auto-repair notice:", seqErr.message);
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
