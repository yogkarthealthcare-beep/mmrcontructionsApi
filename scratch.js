require('dotenv').config();
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/mmrconstructions');

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
