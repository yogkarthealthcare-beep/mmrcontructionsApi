import sql from "../db.js";

async function run() {
  try {
    console.log("--- Tables ---");
    const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    console.log(tables.map(t => t.table_name));

    console.log("\n--- Views ---");
    const views = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'VIEW'
    `;
    console.log(views.map(v => v.table_name));

    console.log("\n--- Checking vw_admin_dashboard_stats ---");
    try {
      const stats = await sql`SELECT * FROM vw_admin_dashboard_stats`;
      console.log("vw_admin_dashboard_stats exists. Row:", stats[0]);
    } catch (e) {
      console.error("vw_admin_dashboard_stats check failed:", e.message);
    }

    console.log("\n--- Checking vw_site_plot_summary ---");
    try {
      const summary = await sql`SELECT * FROM vw_site_plot_summary LIMIT 1`;
      console.log("vw_site_plot_summary exists. Row:", summary[0]);
    } catch (e) {
      console.error("vw_site_plot_summary check failed:", e.message);
    }

  } catch (e) {
    console.error("Error:", e);
  } finally {
    await sql.end();
  }
}

run();
