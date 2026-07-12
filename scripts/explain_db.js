import sql from "../db.js";

async function run() {
  try {
    console.log("--- EXPLAIN ANALYZE for vw_admin_dashboard_stats ---");
    const plan = await sql`
      EXPLAIN ANALYZE SELECT * FROM vw_admin_dashboard_stats
    `;
    console.log(plan.map(p => p['QUERY PLAN']).join('\n'));

  } catch (e) {
    console.error("Error:", e);
  } finally {
    await sql.end();
  }
}

run();
