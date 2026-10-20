/**
 * Knex Migration: Customer Approval Hierarchy Schema (Phase 1)
 * MMR Construction & Developers Pvt. Ltd.
 *
 * Additive non-breaking schema enhancements to store audit-compliant approval and rejection
 * records for:
 * 1. Customer Enrollment Form (customer_enrollment_submissions)
 * 2. Uploaded KYC Documents (user_documents)
 * 3. Document Verification Profiles (user_kyc_profiles)
 *
 * Rules:
 * - 100% additive with IF NOT EXISTS.
 * - Leaves historical records NULL (zero backfill guessing).
 * - Safe local lock timeouts to avoid table lock contention.
 */

export async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  // 1. customer_enrollment_submissions
  await knex.raw(`
    ALTER TABLE customer_enrollment_submissions
      ADD COLUMN IF NOT EXISTS approved_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS approved_by_member_id VARCHAR(50),
      ADD COLUMN IF NOT EXISTS approved_by_name VARCHAR(150),
      ADD COLUMN IF NOT EXISTS approved_by_role VARCHAR(50),
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reject_reason TEXT,
      ADD COLUMN IF NOT EXISTS rejected_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_ces_approved_by ON customer_enrollment_submissions(approved_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_ces_approved_at ON customer_enrollment_submissions(approved_at);
  `);

  // 2. user_documents
  await knex.raw(`
    ALTER TABLE user_documents
      ADD COLUMN IF NOT EXISTS verified_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS verifier_member_id VARCHAR(50),
      ADD COLUMN IF NOT EXISTS verifier_name VARCHAR(150),
      ADD COLUMN IF NOT EXISTS verifier_role VARCHAR(50),
      ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reject_reason TEXT,
      ADD COLUMN IF NOT EXISTS rejected_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_user_docs_verifier_uid ON user_documents(verified_by_user_id);
  `);

  // 3. user_kyc_profiles
  await knex.raw(`
    ALTER TABLE user_kyc_profiles
      ADD COLUMN IF NOT EXISTS reviewed_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS reviewer_member_id VARCHAR(50),
      ADD COLUMN IF NOT EXISTS reviewer_name VARCHAR(150),
      ADD COLUMN IF NOT EXISTS reviewer_role VARCHAR(50),
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reject_reason TEXT,
      ADD COLUMN IF NOT EXISTS rejected_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_user_kyc_reviewer_uid ON user_kyc_profiles(reviewed_by_user_id);
  `);
}

export async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  await knex.raw(`
    ALTER TABLE customer_enrollment_submissions
      DROP COLUMN IF EXISTS approved_by_user_id,
      DROP COLUMN IF EXISTS approved_by_member_id,
      DROP COLUMN IF EXISTS approved_by_name,
      DROP COLUMN IF EXISTS approved_by_role,
      DROP COLUMN IF EXISTS approved_at,
      DROP COLUMN IF EXISTS reject_reason,
      DROP COLUMN IF EXISTS rejected_by_user_id,
      DROP COLUMN IF EXISTS rejected_at;

    ALTER TABLE user_documents
      DROP COLUMN IF EXISTS verified_by_user_id,
      DROP COLUMN IF EXISTS verifier_member_id,
      DROP COLUMN IF EXISTS verifier_name,
      DROP COLUMN IF EXISTS verifier_role,
      DROP COLUMN IF EXISTS verified_at,
      DROP COLUMN IF EXISTS reject_reason,
      DROP COLUMN IF EXISTS rejected_by_user_id,
      DROP COLUMN IF EXISTS rejected_at;

    ALTER TABLE user_kyc_profiles
      DROP COLUMN IF EXISTS reviewed_by_user_id,
      DROP COLUMN IF EXISTS reviewer_member_id,
      DROP COLUMN IF EXISTS reviewer_name,
      DROP COLUMN IF EXISTS reviewer_role,
      DROP COLUMN IF EXISTS reviewed_at,
      DROP COLUMN IF EXISTS reject_reason,
      DROP COLUMN IF EXISTS rejected_by_user_id,
      DROP COLUMN IF EXISTS rejected_at;
  `);
}
