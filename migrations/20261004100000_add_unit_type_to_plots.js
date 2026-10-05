/**
 * Migration: Add unit_type to plots table as config-driven VARCHAR(30)
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  const hasCol = await knex.schema.hasColumn('plots', 'unit_type');
  if (!hasCol) {
    await knex.schema.alterTable('plots', (table) => {
      table.string('unit_type', 50).notNullable().defaultTo('PLOT');
    });
  } else {
    await knex.raw(`
      ALTER TABLE plots ALTER COLUMN unit_type TYPE VARCHAR(50);
    `);
  }

  // Ensure no restrictive check constraint blocks new config-driven unit types
  await knex.raw(`ALTER TABLE plots DROP CONSTRAINT IF EXISTS chk_plots_unit_type;`);
  await knex.raw(`ALTER TABLE plots DROP CONSTRAINT IF EXISTS plots_unit_type_check;`);
  await knex.raw(`
    DO $$
    DECLARE
        r RECORD;
    BEGIN
        FOR r IN (
            SELECT constraint_name
            FROM information_schema.constraint_column_usage
            WHERE table_name = 'plots' AND column_name = 'unit_type'
        ) LOOP
            EXECUTE 'ALTER TABLE plots DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name) || ' CASCADE';
        END LOOP;
    END $$;
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
