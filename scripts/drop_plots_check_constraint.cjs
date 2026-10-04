const postgres = require('postgres');

const sql = postgres({
  host: '66.116.248.35',
  port: 5432,
  database: 'mmrconstructions',
  username: 'mmruser',
  password: 'Admin@333baeb00dA1',
  max: 1
});

async function main() {
  try {
    console.log('Altering table plots to drop constraint and alter column...');
    await sql`ALTER TABLE plots ADD COLUMN IF NOT EXISTS unit_type VARCHAR(50) NOT NULL DEFAULT 'PLOT'`;
    await sql`ALTER TABLE plots ALTER COLUMN unit_type TYPE VARCHAR(50)`;
    await sql`ALTER TABLE plots DROP CONSTRAINT IF EXISTS chk_plots_unit_type`;
    await sql`ALTER TABLE plots DROP CONSTRAINT IF EXISTS plots_unit_type_check`;
    console.log('✅ Constraints dropped successfully!');

    const constraints = await sql`
      SELECT conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = 'plots'::regclass;
    `;
    console.log('Current constraints on plots table:', constraints);
  } catch (err) {
    console.error('❌ Error:', err);
  } finally {
    await sql.end();
    process.exit(0);
  }
}

main();
