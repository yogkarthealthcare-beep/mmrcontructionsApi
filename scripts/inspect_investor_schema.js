import sql from "../db.js";

async function run() {
  try {
    const enrollCols = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'investor_enrollments'
      ORDER BY ordinal_position
    `;
    console.log("investor_enrollments columns:", enrollCols.map(c => `${c.column_name} (${c.data_type})`));

    const userCols = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'investor_users'
      ORDER BY ordinal_position
    `;
    console.log("investor_users columns:", userCols.map(c => `${c.column_name} (${c.data_type})`));

    // Also sample a row if exists
    const [sampleEnroll] = await sql`SELECT * FROM investor_enrollments ORDER BY created_at DESC LIMIT 1`;
    console.log("Sample investor_enrollment:", sampleEnroll ? Object.keys(sampleEnroll) : "No row");

    const [sampleUser] = await sql`SELECT id, full_name, email, mobile_number, member_id, status FROM investor_users ORDER BY id DESC LIMIT 1`;
    console.log("Sample investor_user:", sampleUser);

    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

run();
