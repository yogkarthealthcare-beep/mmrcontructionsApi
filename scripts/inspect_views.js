import sql from "../db.js";

async function run() {
  try {
    console.log("--- vw_admin_dashboard_stats definition ---");
    const statsDef = await sql`
      SELECT pg_get_viewdef('vw_admin_dashboard_stats'::regclass, true) AS def
    `;
    console.log(statsDef[0]?.def);

    console.log("\n--- vw_site_plot_summary definition ---");
    const summaryDef = await sql`
      SELECT pg_get_viewdef('vw_site_plot_summary'::regclass, true) AS def
    `;
    console.log(summaryDef[0]?.def);

  } catch (e) {
    console.error("Error:", e);
  } finally {
    await sql.end();
  }
}

run();
