import sql from "../db.js";

async function check() {
  try {
    console.log("Checking customer enrollment tables in the database...");
    
    // Check submissions table
    const [subTable] = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'customer_enrollment_submissions'
      ) as exists
    `;
    
    // Check nominees table
    const [nomTable] = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'customer_nominees'
      ) as exists
    `;

    console.log("\n------------------------------------------------");
    if (subTable.exists) {
      console.log("✓ Table 'customer_enrollment_submissions' EXISTS!");
    } else {
      console.log("❌ Table 'customer_enrollment_submissions' DOES NOT exist.");
    }

    if (nomTable.exists) {
      console.log("✓ Table 'customer_nominees' EXISTS!");
    } else {
      console.log("❌ Table 'customer_nominees' DOES NOT exist.");
    }
    console.log("------------------------------------------------\n");

    if (subTable.exists && nomTable.exists) {
      console.log("🎉 Great! All customer enrollment tables are created and ready.");
    } else {
      console.log("👉 Please start the backend server locally, or run migrations to create the tables.");
    }
  } catch (error) {
    console.error("❌ Failed to query database:", error.message);
  } finally {
    process.exit(0);
  }
}

check();
