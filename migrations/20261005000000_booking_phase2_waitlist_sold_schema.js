/**
 * Knex Migration: Phase 2 Plot Booking Waitlist, Sold Registry, and Queue Schema
 * Idempotent migration for PostgreSQL.
 */
export async function up(knex) {
  // 1. Ensure columns on 'plots' table
  const hasPlots = await knex.schema.hasTable('plots');
  if (hasPlots) {
    await knex.schema.alterTable('plots', (table) => {
      // Add sold_price and sold_at if not present
      table.decimal('sold_price', 14, 2).nullable();
      table.timestamp('sold_at', { useTz: true }).nullable();
    }).catch(() => {
      // Catch in case columns already exist
    });
  }

  // 2. Ensure columns on 'bookings' table
  const hasBookings = await knex.schema.hasTable('bookings');
  if (hasBookings) {
    await knex.schema.alterTable('bookings', (table) => {
      table.integer('queue_position').defaultTo(1);
      table.boolean('refund_due').defaultTo(false);
      table.text('refund_reason').nullable();
      table.timestamp('refund_marked_at', { useTz: true }).nullable();
      table.integer('refund_marked_by_admin_id').nullable();
    }).catch(() => {
      // Catch in case columns already exist
    });
  }

  // 3. Ensure 'registry_records' table exists
  const hasRegistry = await knex.schema.hasTable('registry_records');
  if (!hasRegistry) {
    await knex.schema.createTable('registry_records', (table) => {
      table.increments('registry_id').primary();
      table.integer('booking_id').notNullable();
      table.integer('user_id').notNullable();
      table.integer('plot_id').notNullable();
      table.string('registry_status', 50).defaultTo('Completed');
      table.string('registry_no', 100).nullable();
      table.date('registry_date').nullable();
      table.date('mutation_date').nullable();
      table.date('possession_date').nullable();
      table.string('document_path', 500).nullable();
      table.decimal('final_sold_price', 14, 2).nullable();
      table.text('remarks').nullable();
      table.integer('created_by_admin_id').nullable();
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      
      table.index(['booking_id']);
      table.index(['plot_id']);
      table.index(['user_id']);
    });
  }

  // 4. Ensure plot_status_history has actor name or columns needed
  const hasStatusHist = await knex.schema.hasTable('plot_status_history');
  if (hasStatusHist) {
    await knex.schema.alterTable('plot_status_history', (table) => {
      table.string('admin_name', 150).nullable();
    }).catch(() => {});
  }
}

export async function down(knex) {
  // Idempotent down migration
  const hasPlots = await knex.schema.hasTable('plots');
  if (hasPlots) {
    await knex.schema.alterTable('plots', (table) => {
      table.dropColumn('sold_price');
      table.dropColumn('sold_at');
    }).catch(() => {});
  }

  const hasBookings = await knex.schema.hasTable('bookings');
  if (hasBookings) {
    await knex.schema.alterTable('bookings', (table) => {
      table.dropColumn('queue_position');
      table.dropColumn('refund_due');
      table.dropColumn('refund_reason');
      table.dropColumn('refund_marked_at');
      table.dropColumn('refund_marked_by_admin_id');
    }).catch(() => {});
  }
}
