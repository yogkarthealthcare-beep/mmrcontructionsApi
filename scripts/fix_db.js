import sql from '../db.js';

async function fix() {
  try {
    console.log("Removing duplicates...");
    await sql`
      DELETE FROM commission_engine_levels a
      USING commission_engine_levels b
      WHERE a.id < b.id
        AND a.settings_id = b.settings_id
        AND a.commission_model = b.commission_model
        AND a.level_no = b.level_no`;
    console.log("Duplicates removed.");

    console.log("Adding constraint...");
    await sql`ALTER TABLE commission_engine_levels ADD CONSTRAINT uq_commission_engine_levels_unique UNIQUE (settings_id, commission_model, level_no)`;
    console.log("Constraint added successfully.");
  } catch (err) {
    console.error("Error applying fix:", err.message);
  } finally {
    process.exit(0);
  }
}

fix();
