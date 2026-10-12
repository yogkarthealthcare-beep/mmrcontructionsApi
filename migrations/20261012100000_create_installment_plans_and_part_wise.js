/**
 * Knex Migration: Installment Plans Master, Part-Wise Deadlines & EMI Component Split (M2)
 * MMR Construction & Developers Pvt. Ltd.
 *
 * Requirements:
 * 1. Create table installment_plans (tenure_months unique, interest_percent, down_payment_percent, is_active, sort_order)
 * 2. Seed 4 canonical plans:
 *    - 12 months: 5.00% interest, 20.00% down payment (sort_order 1)
 *    - 24 months: 10.00% interest, 25.00% down payment (sort_order 2)
 *    - 36 months: 15.00% interest, 30.00% down payment (sort_order 3)
 *    - 60 months: 20.00% interest, 50.00% down payment (sort_order 4)
 * 3. Add part_wise_deadline_months to booking_workflow_settings (default 3)
 * 4. Add installment_plan_id, plan_snapshot, part_wise_deadline_at to bookings
 * 5. Add principal_component, interest_component to emi_schedules
 * 6. Add indexes and safe lock timeout
 */

export async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  // 1. Create installment_plans table
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS installment_plans (
      id SERIAL PRIMARY KEY,
      tenure_months INTEGER UNIQUE NOT NULL CHECK (tenure_months > 0 AND tenure_months <= 120),
      interest_percent NUMERIC(5,2) NOT NULL CHECK (interest_percent >= 0 AND interest_percent <= 100),
      down_payment_percent NUMERIC(5,2) NOT NULL CHECK (down_payment_percent >= 0 AND down_payment_percent <= 100),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 2. Seed initial canonical plans
  await knex.raw(`
    INSERT INTO installment_plans (tenure_months, interest_percent, down_payment_percent, is_active, sort_order)
    VALUES 
      (12, 5.00, 20.00, TRUE, 1),
      (24, 10.00, 25.00, TRUE, 2),
      (36, 15.00, 30.00, TRUE, 3),
      (60, 20.00, 50.00, TRUE, 4)
    ON CONFLICT (tenure_months) DO UPDATE SET
      interest_percent = EXCLUDED.interest_percent,
      down_payment_percent = EXCLUDED.down_payment_percent,
      is_active = EXCLUDED.is_active,
      sort_order = EXCLUDED.sort_order,
      updated_at = NOW();
  `);

  // 3. Add part_wise_deadline_months to booking_workflow_settings
  await knex.raw(`
    ALTER TABLE booking_workflow_settings
      ADD COLUMN IF NOT EXISTS part_wise_deadline_months INTEGER NOT NULL DEFAULT 3 CHECK (part_wise_deadline_months BETWEEN 1 AND 24);
  `);

  // 4. Add columns to bookings
  await knex.raw(`
    ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS installment_plan_id INTEGER REFERENCES installment_plans(id),
      ADD COLUMN IF NOT EXISTS plan_snapshot JSONB,
      ADD COLUMN IF NOT EXISTS part_wise_deadline_at TIMESTAMPTZ;
  `);

  // 5. Add principal and interest components to emi_schedules
  await knex.raw(`
    ALTER TABLE emi_schedules
      ADD COLUMN IF NOT EXISTS principal_component NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS interest_component NUMERIC(14,2);
  `);

  // 6. Helpful indexes
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bookings_installment_plan ON bookings(installment_plan_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_part_wise_deadline ON bookings(part_wise_deadline_at);
    CREATE INDEX IF NOT EXISTS idx_emi_schedules_components ON emi_schedules(booking_id, installment_no);
  `);
}

export async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  await knex.raw(`
    DROP INDEX IF EXISTS idx_emi_schedules_components;
    DROP INDEX IF EXISTS idx_bookings_part_wise_deadline;
    DROP INDEX IF EXISTS idx_bookings_installment_plan;

    ALTER TABLE emi_schedules
      DROP COLUMN IF EXISTS interest_component,
      DROP COLUMN IF EXISTS principal_component;

    ALTER TABLE bookings
      DROP COLUMN IF EXISTS part_wise_deadline_at,
      DROP COLUMN IF EXISTS plan_snapshot,
      DROP COLUMN IF EXISTS installment_plan_id;

    ALTER TABLE booking_workflow_settings
      DROP COLUMN IF EXISTS part_wise_deadline_months;

    DROP TABLE IF EXISTS installment_plans;
  `);
}
