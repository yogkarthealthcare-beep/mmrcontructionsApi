/**
 * Migration: Investor Enrollment Workflow, Auto-Sync & Audit Schema
 * Backward-compatible, idempotent Knex migration.
 * 
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  // 1. Ensure columns exist on investor_enrollments
  await knex.schema.raw(`
    ALTER TABLE investor_enrollments
      ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(20),
      ADD COLUMN IF NOT EXISTS account_number VARCHAR(100),
      ADD COLUMN IF NOT EXISTS corr_address TEXT,
      ADD COLUMN IF NOT EXISTS corr_city VARCHAR(100),
      ADD COLUMN IF NOT EXISTS corr_state VARCHAR(100),
      ADD COLUMN IF NOT EXISTS corr_pin_code VARCHAR(20),
      ADD COLUMN IF NOT EXISTS religion VARCHAR(50),
      ADD COLUMN IF NOT EXISTS is_final_submitted BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
      ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER;
  `);

  // 2. Ensure columns exist on investor_users for profile auto-sync
  await knex.schema.raw(`
    ALTER TABLE investor_users
      ADD COLUMN IF NOT EXISTS enrollment_status VARCHAR(50) DEFAULT 'Pending',
      ADD COLUMN IF NOT EXISTS father_husband_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS date_of_birth DATE,
      ADD COLUMN IF NOT EXISTS gender VARCHAR(20),
      ADD COLUMN IF NOT EXISTS alternate_mobile VARCHAR(50);
  `);

  // 3. Backward-compatible status mapping for old investor records:
  // - If app_status is 'Approved' (or completed): is_final_submitted = TRUE, enrollment_status = 'Completed'
  // - If app_status is 'Rejected': is_final_submitted = FALSE, enrollment_status = 'Rejected'
  // - If old submitted record exists with 'Pending' or 'Hold/Pending KYC': mark is_final_submitted = TRUE
  //   so existing pending investor submissions remain in the admin approval queue.
  await knex.schema.raw(`
    UPDATE investor_enrollments
    SET is_final_submitted = TRUE
    WHERE (LOWER(COALESCE(app_status, '')) IN ('approved', 'completed')
       OR (app_status IS NOT NULL AND LOWER(app_status) NOT IN ('rejected', 'draft')))
      AND is_final_submitted IS NOT TRUE;

    UPDATE investor_users iu
    SET enrollment_status = 'Completed'
    FROM investor_enrollments ie
    WHERE iu.id = ie.investor_id
      AND LOWER(COALESCE(ie.app_status, '')) IN ('approved', 'completed')
      AND COALESCE(iu.enrollment_status, '') <> 'Completed';

    UPDATE investor_users iu
    SET enrollment_status = 'Rejected'
    FROM investor_enrollments ie
    WHERE iu.id = ie.investor_id
      AND LOWER(COALESCE(ie.app_status, '')) = 'rejected'
      AND COALESCE(iu.enrollment_status, '') <> 'Rejected';
  `);
}

/**
 * Rollback migration (safe revert)
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.raw(`
    ALTER TABLE investor_enrollments
      DROP COLUMN IF EXISTS rejection_reason,
      DROP COLUMN IF EXISTS updated_by_user_id;

    ALTER TABLE investor_users
      DROP COLUMN IF EXISTS father_husband_name,
      DROP COLUMN IF EXISTS date_of_birth,
      DROP COLUMN IF EXISTS gender,
      DROP COLUMN IF EXISTS alternate_mobile;
  `);
}
