import bcrypt from 'bcryptjs';
import sql from '../db.js';

const [, , emailArg, passwordArg, nameArg = 'MMR Admin', roleArg = 'SuperAdmin'] = process.argv;

if (!emailArg || !passwordArg) {
  console.error('Usage: node scripts/createAdmin.js <email> <password> [full_name] [role]');
  process.exit(1);
}

const email = emailArg.toLowerCase().trim();
const passwordHash = await bcrypt.hash(passwordArg, 12);

await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS admin_roles (
    role_id SERIAL PRIMARY KEY,
    role_name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

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

await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    session_id SERIAL PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admin_users(admin_id),
    session_token TEXT NOT NULL,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

await sql.unsafe(`
  INSERT INTO admin_roles (role_name)
  VALUES ($1)
  ON CONFLICT (role_name) DO NOTHING
`, [roleArg]);

const [role] = await sql.unsafe(`
  SELECT role_id, role_name
  FROM admin_roles
  WHERE role_name = $1
`, [roleArg]);

await sql.unsafe(`
  INSERT INTO admin_users (role_id, full_name, email, password_hash, is_active, is_locked, failed_login_attempts)
  VALUES ($1, $2, $3, $4, TRUE, FALSE, 0)
  ON CONFLICT (email) DO UPDATE SET
    role_id = EXCLUDED.role_id,
    full_name = EXCLUDED.full_name,
    password_hash = EXCLUDED.password_hash,
    is_active = TRUE,
    is_locked = FALSE,
    failed_login_attempts = 0,
    updated_at = NOW()
`, [role.role_id, nameArg, email, passwordHash]);

const [admin] = await sql.unsafe(`
  SELECT a.admin_id, a.full_name, a.email, r.role_name AS role, a.is_active, a.is_locked
  FROM admin_users a
  JOIN admin_roles r ON a.role_id = r.role_id
  WHERE a.email = $1
`, [email]);

console.log(JSON.stringify({
  success: true,
  message: 'Admin account created or updated',
  admin,
}, null, 2));

await sql.end();
