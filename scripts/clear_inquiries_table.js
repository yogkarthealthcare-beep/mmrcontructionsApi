import sql from "../db.js";

async function clearInquiries() {
  try {
    console.log("=== CLEARING ALL DATA FROM INQUIRIES TABLE ===");
    await sql.unsafe(`TRUNCATE TABLE inquiries RESTART IDENTITY CASCADE;`);
    console.log("✅ inquiries table truncated successfully.");

    try {
      await sql.unsafe(`TRUNCATE TABLE book_plot_leads RESTART IDENTITY CASCADE;`);
      console.log("✅ book_plot_leads table truncated successfully.");
    } catch (e) {
      console.log("Note on book_plot_leads:", e.message);
    }

    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to truncate inquiries table:", err.message);
    process.exit(1);
  }
}

clearInquiries();

