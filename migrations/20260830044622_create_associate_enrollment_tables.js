/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  // 1. Master Table: associate_enrollment
  await knex.schema.createTable("associate_enrollment", (table) => {
    table.string("id", 50).primary(); // Auto-generated associate ID as PK (e.g. MMR-ASC-YYYY-XXXX)
    table.string("full_name", 150).notNullable();
    table.date("dob").notNullable();
    table.string("gender", 20).notNullable();
    table.string("father_name", 150);
    table.string("mother_name", 150);
    table.string("spouse_name", 150);
    table.string("contact_no_1", 15).notNullable();
    table.string("contact_no_2", 15);
    table.string("nationality", 50).defaultTo("Indian");
    table.string("residential_status", 50);
    table.string("pan_no", 10).unique().notNullable();
    table.string("aadhar_no", 12).unique().notNullable();
    table.string("email", 150);
    table.string("occupation", 100);
    table.string("annual_income", 50);
    table.string("education", 100);
    table.string("category", 50);
    table.string("religion", 50);
    table.text("applicant_photo_path");
    table.date("sign_date");
    table.boolean("terms_accepted").defaultTo(false).notNullable();
    table.timestamp("terms_accepted_at");
    table.string("status", 20).defaultTo("pending").notNullable(); // pending, approved, rejected
    table.timestamps(true, true); // created_at, updated_at
  });

  // 2. Child Table: associate_address
  await knex.schema.createTable("associate_address", (table) => {
    table.increments("id").primary();
    table.string("associate_id", 50).notNullable()
      .references("id").inTable("associate_enrollment")
      .onDelete("CASCADE");
    table.string("address_type", 20).notNullable(); // permanent, local
    table.text("local_address");
    table.string("city", 100);
    table.string("state", 100);
    table.string("country", 100).defaultTo("India");
    table.string("pin_code", 10);
  });

  // 3. Child Table: associate_bank_details
  await knex.schema.createTable("associate_bank_details", (table) => {
    table.increments("id").primary();
    table.string("associate_id", 50).notNullable()
      .references("id").inTable("associate_enrollment")
      .onDelete("CASCADE");
    table.string("bank_name", 150);
    table.string("account_holder_name", 150);
    table.string("account_no", 50);
    table.string("ifsc_code", 20);
    table.string("micr_code", 20);
    table.string("branch_name", 150);
    table.string("branch_code", 50);
    table.string("swift_code", 20);
    table.string("branch_country", 100).defaultTo("India");
  });

  // 4. Child Table: associate_nominee
  await knex.schema.createTable("associate_nominee", (table) => {
    table.increments("id").primary();
    table.string("associate_id", 50).notNullable()
      .references("id").inTable("associate_enrollment")
      .onDelete("CASCADE");
    table.string("nominee_name", 150);
    table.date("dob");
    table.string("gender", 20);
    table.string("nationality", 50).defaultTo("Indian");
    table.string("residential_status", 50);
    table.string("relationship", 80);
    table.string("pan_name", 150);
    table.string("pan_no", 10);
    table.string("aadhar_name", 150);
    table.string("aadhar_no", 12);
    table.text("address");
    table.text("photo_path");
  });

  // 5. Child Table: associate_sponsor
  await knex.schema.createTable("associate_sponsor", (table) => {
    table.increments("id").primary();
    table.string("associate_id", 50).notNullable()
      .references("id").inTable("associate_enrollment")
      .onDelete("CASCADE");
    table.string("sponsor_name", 150);
    table.string("sponsor_code", 50);
    table.string("sponsor_contact", 15);
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  // Drop child tables first, then master
  await knex.schema.dropTableIfExists("associate_sponsor");
  await knex.schema.dropTableIfExists("associate_nominee");
  await knex.schema.dropTableIfExists("associate_bank_details");
  await knex.schema.dropTableIfExists("associate_address");
  await knex.schema.dropTableIfExists("associate_enrollment");
}
