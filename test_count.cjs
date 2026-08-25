require('dotenv').config();
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL);

async function run() {
  try {
    const res1 = await sql`SELECT user_type, count(*) FROM users GROUP BY user_type`;
    console.log("User breakdown:", res1);
  } catch(e) {
    console.error(e);
  } finally {
    process.exit();
  }
}
run();
