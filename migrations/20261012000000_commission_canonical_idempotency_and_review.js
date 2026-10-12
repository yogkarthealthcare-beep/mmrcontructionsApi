/**
 * Knex Migration: Commission Canonical Idempotency, Integer-Paise Metadata & Review Flag
 * MMR Construction & Developers Pvt. Ltd.
 *
 * Requirements:
 * 1. Additive column event_key and partial unique index on commission_source_events(booking_id, event_key)
 * 2. Additive columns undistributed_amount & settings_snapshot on commission_source_events
 * 3. Additive columns event_key, needs_review, review_reason on commission_transactions
 * 4. Safe SET LOCAL lock_timeout, fully idempotent, and clean down migration
 */

export async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  await knex.raw(`
    ALTER TABLE commission_source_events
      ADD COLUMN IF NOT EXISTS event_key TEXT,
      ADD COLUMN IF NOT EXISTS undistributed_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS settings_snapshot JSONB;
  `);

  await knex.raw(`
    ALTER TABLE commission_transactions
      ADD COLUMN IF NOT EXISTS event_key TEXT,
      ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS review_reason TEXT;
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_events_booking_event_key
    ON commission_source_events(booking_id, event_key)
    WHERE event_key IS NOT NULL;
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_commission_tx_booking_review
    ON commission_transactions(related_booking_id, needs_review);
  `);
}

export async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  await knex.raw(`
    DROP INDEX IF EXISTS idx_commission_tx_booking_review;
    DROP INDEX IF EXISTS uq_commission_events_booking_event_key;
    ALTER TABLE commission_transactions
      DROP COLUMN IF EXISTS review_reason,
      DROP COLUMN IF EXISTS needs_review,
      DROP COLUMN IF EXISTS event_key;
    ALTER TABLE commission_source_events
      DROP COLUMN IF EXISTS settings_snapshot,
      DROP COLUMN IF EXISTS undistributed_amount,
      DROP COLUMN IF EXISTS event_key;
  `);
}
