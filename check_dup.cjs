require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function test() {
  const rows = await sql`SELECT * FROM associate_sales_tracker WHERE associate_user_id = 139`;
  console.log('associate_sales_tracker for 139:', rows.length, rows);
  
  const dupTracker = await sql`
    SELECT associate_user_id, count(*) as count
    FROM associate_sales_tracker
    GROUP BY associate_user_id
    HAVING count(*) > 1
  `;
  console.log('duplicate trackers:', dupTracker);
}
test();
