import dotenv from 'dotenv';
dotenv.config();
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL || {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'mmrconstructions',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

async function runMigration() {
  console.log('[Migration] Starting member ID format migration...');

  // 1. Ensure investor_users has member_id column
  try {
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS member_id VARCHAR(50)`;
    console.log('[Migration] Ensured investor_users.member_id column');
  } catch (err) {
    console.warn('[Migration] investor_users alter warning:', err.message);
  }

  // 2. Update existing Associate users in users table
  const resAssoc = await sql`
    UPDATE users 
    SET member_id = 'MMR-ASC-' || LPAD(COALESCE(SUBSTRING(regexp_replace(member_id, '^MMR(-ASC-|-A-)?', '', 'i') FROM '[0-9]+'), user_id::text), 5, '0')
    WHERE LOWER(user_type::TEXT) = 'associate' AND (member_id IS NOT NULL OR user_id IS NOT NULL)
    RETURNING user_id, member_id, full_name, user_type
  `;
  console.log(`[Migration] Updated ${resAssoc.length} Associate users:`, resAssoc);

  // 3. Update existing Customer users in users table
  const resCust = await sql`
    UPDATE users 
    SET member_id = 'MMR-CUS-' || LPAD(COALESCE(SUBSTRING(regexp_replace(member_id, '^MMR(-CUS-|-C-)?', '', 'i') FROM '[0-9]+'), user_id::text), 5, '0')
    WHERE LOWER(user_type::TEXT) = 'customer' AND (member_id IS NOT NULL OR user_id IS NOT NULL)
    RETURNING user_id, member_id, full_name, user_type
  `;
  console.log(`[Migration] Updated ${resCust.length} Customer users:`, resCust);

  // 4. Update team_members table if exists
  try {
    const resTm = await sql`
      UPDATE team_members
      SET team_member_uid = 'MMR-TM-' || LPAD(COALESCE(SUBSTRING(regexp_replace(team_member_uid, '^MMR-TM-([0-9]+-)?', '', 'i') FROM '[0-9]+'), id::text), 5, '0')
      WHERE team_member_uid IS NOT NULL
      RETURNING id, team_member_uid, full_name
    `;
    console.log(`[Migration] Updated ${resTm.length} Team Members:`, resTm);
  } catch (err) {
    console.warn('[Migration] team_members update warning:', err.message);
  }

  // 5. Update investor_users table
  try {
    const resInv = await sql`
      UPDATE investor_users
      SET member_id = 'MMR-INV-' || LPAD(COALESCE(SUBSTRING(regexp_replace(member_id, '^MMR-INV-', '', 'i') FROM '[0-9]+'), id::text), 5, '0')
      RETURNING id, member_id, full_name
    `;
    console.log(`[Migration] Updated ${resInv.length} Investors:`, resInv);
  } catch (err) {
    console.warn('[Migration] investor_users update warning:', err.message);
  }

  // 6. Create or replace PostgreSQL helper function fn_generate_member_id
  await sql`
    CREATE OR REPLACE FUNCTION fn_generate_member_id(p_user_type VARCHAR)
    RETURNS VARCHAR AS $$
    DECLARE
        v_prefix VARCHAR;
        v_seq INTEGER;
        v_type VARCHAR;
    BEGIN
        v_type := LOWER(COALESCE(p_user_type, 'customer'));
        IF v_type LIKE '%assoc%' THEN
            v_prefix := 'MMR-ASC-';
            SELECT COALESCE(MAX(
                CASE 
                    WHEN member_id ~ '^MMR-ASC-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::INTEGER
                    WHEN member_id ~ '^MMR-A-[0-9]+$' THEN SUBSTRING(member_id FROM 7)::INTEGER
                    WHEN member_id ~ '^MMR[0-9]+$' AND LOWER(user_type::TEXT) = 'associate' THEN SUBSTRING(member_id FROM 4)::INTEGER
                    ELSE 0 
                END
            ), 0) + 1 INTO v_seq FROM users;
        ELSIF v_type LIKE '%team%' THEN
            v_prefix := 'MMR-TM-';
            SELECT COALESCE(MAX(
                CASE 
                    WHEN team_member_uid ~ '^MMR-TM-[0-9]+$' THEN SUBSTRING(team_member_uid FROM 8)::INTEGER
                    WHEN team_member_uid ~ '^MMR-TM-[0-9]+-[0-9]+$' THEN SUBSTRING(team_member_uid FROM 13)::INTEGER
                    ELSE 0 
                END
            ), 0) + 1 INTO v_seq FROM team_members;
        ELSIF v_type LIKE '%invest%' THEN
            v_prefix := 'MMR-INV-';
            SELECT COALESCE(MAX(
                CASE 
                    WHEN member_id ~ '^MMR-INV-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::INTEGER
                    ELSE id 
                END
            ), 0) + 1 INTO v_seq FROM investor_users;
        ELSE
            v_prefix := 'MMR-CUS-';
            SELECT COALESCE(MAX(
                CASE 
                    WHEN member_id ~ '^MMR-CUS-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::INTEGER
                    WHEN member_id ~ '^MMR-C-[0-9]+$' THEN SUBSTRING(member_id FROM 7)::INTEGER
                    WHEN member_id ~ '^MMR[0-9]+$' AND LOWER(user_type::TEXT) = 'customer' THEN SUBSTRING(member_id FROM 4)::INTEGER
                    ELSE 0 
                END
            ), 0) + 1 INTO v_seq FROM users;
        END IF;
        RETURN v_prefix || LPAD(v_seq::VARCHAR, 5, '0');
    END;
    $$ LANGUAGE plpgsql;
  `;
  console.log('[Migration] PostgreSQL function fn_generate_member_id created/replaced successfully.');

  console.log('[Migration] Migration complete!');
  process.exit(0);
}

runMigration().catch(err => {
  console.error('[Migration] Failed:', err);
  process.exit(1);
});
