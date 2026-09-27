import "../config/loadEnv.js";
import sql from "../db.js";

async function test() {
  const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%associate%'`;
  console.log('Tables:', tables);
  for (const t of tables) {
    const cols = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ${t.table_name}`;
    console.log(t.table_name, cols.map(c => c.column_name));
  }
  process.exit(0);
}
test().catch(e => { console.error(e); process.exit(1); });
