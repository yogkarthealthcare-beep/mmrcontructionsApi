/**
 * Knex Migration: Standardize Team Member Sponsor ID Generator (MMR-TM-XXXX)
 * MMR Construction & Developers Pvt. Ltd.
 *
 * Target: PostgreSQL helper function fn_generate_member_id(p_user_type VARCHAR)
 *
 * Requirements:
 * 1. For 'team member': calculates MAX numeric tail from BOTH users.member_id and team_members.team_member_uid.
 * 2. Formats as 'MMR-TM-' || LPAD(seq::text, 4, '0') (canonical 4-digit format).
 * 3. Preserves Associate ('MMR-ASC-') and Customer ('MMR-CUS-') formats exactly as-is.
 * 4. Idempotent, safe lock timeouts, and safe down migration.
 */

export async function up(knex) {
  // Use SET LOCAL to isolate timeouts strictly to this transaction (prevents pool leak)
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION fn_generate_member_id(p_user_type VARCHAR)
    RETURNS VARCHAR AS $$
    DECLARE
        v_prefix VARCHAR;
        v_seq BIGINT;
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
            RETURN v_prefix || LPAD(v_seq::VARCHAR, 4, '0');
        ELSIF v_type LIKE '%team%' THEN
            v_prefix := 'MMR-TM-';
            WITH id_candidates AS (
              SELECT member_id AS id_str
              FROM users
              WHERE member_id ~* '^MMR-TM-[0-9]+$'
                 OR member_id ~* '^MMR-TM-[0-9]+-[0-9]+$'
                 OR member_id ~* '^TM-[0-9]+$'
              UNION ALL
              SELECT team_member_uid AS id_str
              FROM team_members
              WHERE team_member_uid ~* '^MMR-TM-[0-9]+$'
                 OR team_member_uid ~* '^MMR-TM-[0-9]+-[0-9]+$'
                 OR team_member_uid ~* '^TM-[0-9]+$'
            )
            SELECT COALESCE(MAX(
              CASE
                WHEN id_str ~* '^MMR-TM-[0-9]+$' THEN SUBSTRING(id_str FROM 8)::BIGINT
                WHEN id_str ~* '^MMR-TM-[0-9]+-[0-9]+$' THEN SUBSTRING(id_str FROM 13)::BIGINT
                WHEN id_str ~* '^TM-[0-9]+$' THEN SUBSTRING(id_str FROM 4)::BIGINT
                ELSE 0 END
            ), 0) + 1 INTO v_seq FROM id_candidates;
            RETURN v_prefix || LPAD(v_seq::VARCHAR, 4, '0');
        ELSIF v_type LIKE '%invest%' THEN
            v_prefix := 'MMR-INV-';
            SELECT COALESCE(MAX(
                CASE 
                    WHEN member_id ~ '^MMR-INV-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::INTEGER
                    ELSE id 
                END
            ), 0) + 1 INTO v_seq FROM investor_users;
            RETURN v_prefix || LPAD(v_seq::VARCHAR, 5, '0');
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
            RETURN v_prefix || LPAD(v_seq::VARCHAR, 5, '0');
        END IF;
    END;
    $$ LANGUAGE plpgsql;
  `);
}

export async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  await knex.raw(`
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
            RETURN v_prefix || LPAD(v_seq::VARCHAR, 4, '0');
        ELSIF v_type LIKE '%team%' THEN
            v_prefix := 'MMR-TM-';
            SELECT COALESCE(MAX(
                CASE 
                    WHEN team_member_uid ~ '^MMR-TM-[0-9]+$' THEN SUBSTRING(team_member_uid FROM 8)::INTEGER
                    WHEN team_member_uid ~ '^MMR-TM-[0-9]+-[0-9]+$' THEN SUBSTRING(team_member_uid FROM 13)::INTEGER
                    ELSE 0 
                END
            ), 0) + 1 INTO v_seq FROM team_members;
            RETURN v_prefix || LPAD(v_seq::VARCHAR, 5, '0');
        ELSIF v_type LIKE '%invest%' THEN
            v_prefix := 'MMR-INV-';
            SELECT COALESCE(MAX(
                CASE 
                    WHEN member_id ~ '^MMR-INV-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::INTEGER
                    ELSE id 
                END
            ), 0) + 1 INTO v_seq FROM investor_users;
            RETURN v_prefix || LPAD(v_seq::VARCHAR, 5, '0');
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
            RETURN v_prefix || LPAD(v_seq::VARCHAR, 5, '0');
        END IF;
    END;
    $$ LANGUAGE plpgsql;
  `);
}
