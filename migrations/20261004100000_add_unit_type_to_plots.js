/**
 * Migration: Add unit_type to plots table as config-driven VARCHAR(30)
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  const hasCol = await knex.schema.hasColumn('plots', 'unit_type');
  if (!hasCol) {
    await knex.schema.alterTable('plots', (table) => {
      table.string('unit_type', 30).notNullable().defaultTo('PLOT');
    });
  } else {
    await knex.raw(`
      ALTER TABLE plots ALTER COLUMN unit_type TYPE VARCHAR(30);
    `);
  }

  // Ensure no restrictive check constraint blocks new config-driven unit types
  await knex.raw(`
    ALTER TABLE plots DROP CONSTRAINT IF EXISTS chk_plots_unit_type;
    ALTER TABLE plots DROP CONSTRAINT IF EXISTS plots_unit_type_check;
  `);
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  const hasCol = await knex.schema.hasColumn('plots', 'unit_type');
  if (hasCol) {
    await knex.schema.alterTable('plots', (table) => {
      table.dropColumn('unit_type');
    });
  }
}
