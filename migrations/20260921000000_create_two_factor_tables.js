/**
 * Migration: Create two_factor_config and two_factor_otp_logs tables
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  const configExists = await knex.schema.hasTable("two_factor_config");
  if (!configExists) {
    await knex.schema.createTable("two_factor_config", (table) => {
      table.increments("id").primary();
      table.string("provider", 50).notNullable().defaultTo("2Factor");
      table.text("api_key_encrypted").nullable();
      table.boolean("is_active").notNullable().defaultTo(true);
      table.string("updated_by", 100).nullable();
      table.timestamps(true, true);
    });

    // Insert default single configuration row if not present
    await knex.raw(`
      INSERT INTO two_factor_config (id, provider, is_active, created_at, updated_at)
      VALUES (1, '2Factor', true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `);
  }

  const logsExists = await knex.schema.hasTable("two_factor_otp_logs");
  if (!logsExists) {
    await knex.schema.createTable("two_factor_otp_logs", (table) => {
      table.bigIncrements("id").primary();
      table.string("admin_user_id", 100).nullable();
      table.string("mobile_number", 30).notNullable();
      table.string("template", 100).notNullable();
      table.string("provider", 50).notNullable().defaultTo("2Factor");
      table.string("status", 50).notNullable();
      table.string("provider_reference_id", 255).nullable();
      table.string("error_code", 100).nullable();
      table.text("error_message").nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(knex.fn.now());
    });

    await knex.schema.raw(`
      CREATE INDEX IF NOT EXISTS idx_two_factor_logs_created_at ON two_factor_otp_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_two_factor_logs_mobile ON two_factor_otp_logs(mobile_number);
    `);
  }
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("two_factor_otp_logs");
  await knex.schema.dropTableIfExists("two_factor_config");
}
