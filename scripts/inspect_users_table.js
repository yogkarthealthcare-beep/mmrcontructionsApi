import sql from "../db.js";

async function run() {
  try {
    const columns = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users'
    `;
    console.log("--- Columns in users table ---");
    console.log(columns);
  } catch (e) {
    console.error(e);
  } finally {
    await sql.end();
  }
}
run();
