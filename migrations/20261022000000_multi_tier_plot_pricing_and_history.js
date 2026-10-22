/**
 * Knex Migration: Multi-Tier Plot Pricing, Price History Audit & Customer Proposed Rate Workflow
 * MMR Construction & Developers Pvt. Ltd.
 *
 * Requirements:
 * 1. Create table plot_price_history (plot_id, old_price, new_price, rate_per_gaj, rate_per_sqft, changed_by_admin_id, changed_at, source)
 * 2. Add columns to bookings:
 *    - list_price NUMERIC(14,2) NULL
 *    - price_overridden BOOLEAN NOT NULL DEFAULT FALSE
 *    - price_set_by_user_id INTEGER NULL
 *    - requested_price NUMERIC(14,2) NULL
 * 3. Add columns to booking_workflow_settings:
 *    - min_plot_price NUMERIC(14,2) NOT NULL DEFAULT 200000
 *    - min_emi_down_payment NUMERIC(14,2) NOT NULL DEFAULT 30000
 *    - part_wise_installments INTEGER NOT NULL DEFAULT 4
 *    - part_wise_first_percent NUMERIC(5,2) NOT NULL DEFAULT 25.00
 *    - part_wise_gap_days INTEGER NOT NULL DEFAULT 7
 *    - reference_rate_per_gaj NUMERIC(14,2) NOT NULL DEFAULT 8000
 */

export async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  // 1. Create plot_price_history table
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS plot_price_history (
      id SERIAL PRIMARY KEY,
      plot_id INTEGER NOT NULL,
      old_price NUMERIC(14,2) NULL,
      new_price NUMERIC(14,2) NOT NULL,
      rate_per_gaj NUMERIC(14,2) NULL,
      rate_per_sqft NUMERIC(14,2) NULL,
      changed_by_admin_id INTEGER NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source VARCHAR(50) NOT NULL DEFAULT 'MANUAL_EDIT'
    );
    CREATE INDEX IF NOT EXISTS idx_plot_price_history_plot_id ON plot_price_history(plot_id);
    CREATE INDEX IF NOT EXISTS idx_plot_price_history_changed_at ON plot_price_history(changed_at DESC);
  `);

  // 2. Add columns to bookings
  await knex.raw(`
    ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS list_price NUMERIC(14,2) NULL,
      ADD COLUMN IF NOT EXISTS price_overridden BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS price_set_by_user_id INTEGER NULL,
      ADD COLUMN IF NOT EXISTS requested_price NUMERIC(14,2) NULL,
      ADD COLUMN IF NOT EXISTS price_approval_status VARCHAR(50) NULL DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS price_approved_by INTEGER NULL,
      ADD COLUMN IF NOT EXISTS price_approved_at TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS price_admin_counter NUMERIC(14,2) NULL,
      ADD COLUMN IF NOT EXISTS price_rejection_reason TEXT NULL;
  `);

  // 3. Add columns to booking_workflow_settings
  await knex.raw(`
    ALTER TABLE booking_workflow_settings
      ADD COLUMN IF NOT EXISTS min_plot_price NUMERIC(14,2) NOT NULL DEFAULT 200000,
      ADD COLUMN IF NOT EXISTS min_emi_down_payment NUMERIC(14,2) NOT NULL DEFAULT 30000,
      ADD COLUMN IF NOT EXISTS part_wise_installments INTEGER NOT NULL DEFAULT 4,
      ADD COLUMN IF NOT EXISTS part_wise_first_percent NUMERIC(5,2) NOT NULL DEFAULT 25.00,
      ADD COLUMN IF NOT EXISTS part_wise_gap_days INTEGER NOT NULL DEFAULT 7,
      ADD COLUMN IF NOT EXISTS reference_rate_per_gaj NUMERIC(14,2) NOT NULL DEFAULT 8000;
  `);

  // 4. Update settings row #1 default values if null
  await knex.raw(`
    UPDATE booking_workflow_settings SET
      min_plot_price = COALESCE(min_plot_price, 200000),
      min_emi_down_payment = COALESCE(min_emi_down_payment, 30000),
      part_wise_installments = COALESCE(part_wise_installments, 4),
      part_wise_first_percent = COALESCE(part_wise_first_percent, 25.00),
      part_wise_gap_days = COALESCE(part_wise_gap_days, 7),
      reference_rate_per_gaj = COALESCE(reference_rate_per_gaj, 8000)
    WHERE id = 1;
  `);
}

export async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  await knex.raw(`
    ALTER TABLE booking_workflow_settings
      DROP COLUMN IF EXISTS reference_rate_per_gaj,
      DROP COLUMN IF EXISTS part_wise_gap_days,
      DROP COLUMN IF EXISTS part_wise_first_percent,
      DROP COLUMN IF EXISTS part_wise_installments,
      DROP COLUMN IF EXISTS min_emi_down_payment,
      DROP COLUMN IF EXISTS min_plot_price;

    ALTER TABLE bookings
      DROP COLUMN IF EXISTS requested_price,
      DROP COLUMN IF EXISTS price_set_by_user_id,
      DROP COLUMN IF EXISTS price_overridden,
      DROP COLUMN IF EXISTS list_price;

    DROP TABLE IF EXISTS plot_price_history CASCADE;
  `);
}
