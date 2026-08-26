const postgres = require('postgres');
const sql = postgres({
  host: '66.116.248.35',
  port: 5432,
  database: 'mmrconstructions',
  user: 'mmruser',
  password: 'Admin@333baeb00dA1'
});

async function test() {
  try {
    const res = await sql`SELECT * FROM emi_calculator_master`;
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
test();
