/**
 * Migration: Create team_members table
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  const exists = await knex.schema.hasTable("team_members");
  if (!exists) {
    await knex.schema.createTable("team_members", (table) => {
      table.bigIncrements("id").primary();
      table.string("team_member_uid", 30).unique().notNullable();
      table.bigInteger("associate_id").notNullable().index();
      table.string("associate_name", 150).notNullable();
      table.string("full_name", 150).notNullable();
      table.string("father_husband_name", 150).notNullable();
      table.date("date_of_birth").notNullable();
      table.string("gender", 15).notNullable();
      table.string("aadhar_no", 12).unique().notNullable();
      table.string("pan_no", 10).nullable();
      table.string("mobile_no", 15).notNullable();
      table.string("email_id", 150).nullable();
      table.text("full_address").notNullable();
      table.string("photo_url", 255).nullable();
      table.string("nominee_name", 150).nullable();
      table.string("nominee_relation", 80).nullable();
      table.string("nominee_age_dob", 30).nullable();
      table.string("nominee_contact_no", 15).nullable();
      table.string("bank_name", 150).notNullable();
      table.string("branch_name", 150).notNullable();
      table.string("account_no", 30).notNullable();
      table.string("ifsc_code", 15).notNullable();
      table.boolean("declaration_accepted").defaultTo(false).notNullable();
      table.string("applicant_signature_url", 255).nullable();
      table.string("associate_signature_url", 255).nullable();
      table.string("authorized_signatory_name", 150).nullable();
      table.string("status", 20).defaultTo("pending").notNullable().index();
      table.timestamps(true, true);
    });

    // Add composite or special indexes
    await knex.schema.raw(`
      CREATE INDEX IF NOT EXISTS idx_team_members_associate_created 
      ON team_members (associate_id, created_at DESC);
    `);
  }
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("team_members");
}
