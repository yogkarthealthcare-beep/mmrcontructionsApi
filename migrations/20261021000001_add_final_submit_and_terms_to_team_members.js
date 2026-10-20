/**
 * Migration: Add is_final_submitted to team_members
 * and safely backfill approved-status team members to is_final_submitted = TRUE (guarded against unlock audit).
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.raw(`
    ALTER TABLE team_members
      ADD COLUMN IF NOT EXISTS is_final_submitted BOOLEAN NOT NULL DEFAULT FALSE;

    DO $$
    BEGIN
      -- Guarded backfill: Only backfill approved members that are currently is_final_submitted = FALSE
      -- and have never been unlocked by an Admin/SuperAdmin (excludes records in team_member_unlock_audit).
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'team_member_unlock_audit') THEN
        UPDATE team_members
        SET is_final_submitted = TRUE
        WHERE LOWER(status) = 'approved'
          AND is_final_submitted = FALSE
          AND team_member_uid NOT IN (SELECT team_member_uid FROM team_member_unlock_audit);
      ELSE
        UPDATE team_members
        SET is_final_submitted = TRUE
        WHERE LOWER(status) = 'approved'
          AND is_final_submitted = FALSE;
      END IF;
    END $$;
  `);
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.raw(`
    ALTER TABLE team_members
      DROP COLUMN IF EXISTS is_final_submitted;
  `);
}
