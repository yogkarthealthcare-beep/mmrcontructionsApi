/**
 * Migration: Add is_final_submitted to investor_enrollments
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.raw(`
    ALTER TABLE investor_enrollments
      ADD COLUMN IF NOT EXISTS is_final_submitted BOOLEAN NOT NULL DEFAULT FALSE;
  `);
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.raw(`
    ALTER TABLE investor_enrollments
      DROP COLUMN IF EXISTS is_final_submitted;
  `);
}
