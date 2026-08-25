import sql from "./db.js";
async function test() {
  const users = await sql`SELECT user_id, member_id, full_name, email FROM users WHERE user_type = 'Associate' ORDER BY user_id`;
  console.log('Associates in DB:', users);
  
  const dupTracker = await sql`
    SELECT associate_user_id, count(*) as count
    FROM associate_sales_tracker
    GROUP BY associate_user_id
    HAVING count(*) > 1
  `;
  console.log('duplicate trackers:', dupTracker);
  process.exit(0);
}
test();
