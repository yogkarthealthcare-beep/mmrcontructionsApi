/**
 * Migration: Create receipts and receipt_audit_log tables
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  const receiptsExists = await knex.schema.hasTable("receipts");
  if (!receiptsExists) {
    await knex.schema.createTable("receipts", (table) => {
      table.bigIncrements("id").primary();
      table.string("receipt_no", 100).unique().notNullable();
      table.integer("serial_no").notNullable().defaultTo(1);
      table.string("plot_no", 100).nullable();
      table.string("plot_area", 100).nullable();
      table.bigInteger("customer_id").nullable();
      table.string("customer_name", 255).notNullable();
      table.string("mobile_no", 25).notNullable();
      table.string("r_o_p", 255).nullable();
      table.string("payment_type", 50).notNullable().defaultTo("Cash");
      table.string("payment_mode", 100).notNullable().defaultTo("Full Payment");
      table.string("cheque_no", 100).nullable();
      table.date("cheque_date").nullable();
      table.string("bank_name", 255).nullable();
      table.decimal("receipt_amount", 14, 2).notNullable().defaultTo(0.00);
      table.decimal("paid_amount", 14, 2).notNullable().defaultTo(0.00);
      table.decimal("inward_amount", 14, 2).notNullable().defaultTo(0.00);
      table.string("amount_depositor_name", 255).nullable();
      table.string("advisor_name", 255).nullable();
      table.string("advisor_mobile", 25).nullable();
      table.timestamp("full_payment_time", { useTz: true }).nullable();
      table.date("receipt_date").notNullable().defaultTo(knex.raw("CURRENT_DATE"));
      table.string("plotting_place", 255).notNullable().defaultTo("NEW M.M.R. CITY, Kanpur Lucknow Road, N.H.-27 Road Near Jajmau Tribhuwan Kheda (Unnao)");
      table.text("depositor_signature").nullable();
      table.text("authorized_signature").nullable();
      table.text("notes").nullable();
      table.string("status", 50).notNullable().defaultTo("Active");
      table.boolean("is_locked").notNullable().defaultTo(true);
      table.bigInteger("created_by").nullable();
      table.bigInteger("updated_by").nullable();
      table.timestamps(true, true);
    });

    // Indexes
    await knex.schema.raw(`
      CREATE INDEX IF NOT EXISTS idx_receipts_receipt_no ON receipts(receipt_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_serial_no ON receipts(serial_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_customer_name ON receipts(customer_name);
      CREATE INDEX IF NOT EXISTS idx_receipts_mobile_no ON receipts(mobile_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_plot_no ON receipts(plot_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_receipt_date ON receipts(receipt_date);
      CREATE INDEX IF NOT EXISTS idx_receipts_customer_id ON receipts(customer_id);
      CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
      CREATE INDEX IF NOT EXISTS idx_receipts_created_at ON receipts(created_at DESC);
    `);
  }

  const auditExists = await knex.schema.hasTable("receipt_audit_log");
  if (!auditExists) {
    await knex.schema.createTable("receipt_audit_log", (table) => {
      table.bigIncrements("id").primary();
      table.bigInteger("receipt_id").notNullable();
      table.string("receipt_no", 100).notNullable();
      table.string("action", 50).notNullable();
      table.bigInteger("performed_by").nullable();
      table.string("performed_by_name", 255).nullable();
      table.jsonb("details").nullable();
      table.timestamp("created_at", { useTz: true }).defaultTo(knex.fn.now());
    });

    await knex.schema.raw(`
      CREATE INDEX IF NOT EXISTS idx_receipt_audit_receipt_id ON receipt_audit_log(receipt_id);
      CREATE INDEX IF NOT EXISTS idx_receipt_audit_receipt_no ON receipt_audit_log(receipt_no);
    `);
  }
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("receipt_audit_log");
  await knex.schema.dropTableIfExists("receipts");
}
