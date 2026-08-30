import sql from "../db.js";

async function run() {
  try {
    console.log("Cleaning up test associate enrollment data...");
    
    // Deletes test entries where full_name contains 'Test', email contains 'test', or pan_no starts with 'TEST'
    const result = await sql`
      DELETE FROM associate_enrollment 
      WHERE full_name ILIKE '%test%' 
         OR email ILIKE '%test%' 
         OR pan_no ILIKE 'test%'
      RETURNING id, full_name, pan_no
    `;
    
    console.log(`Successfully deleted ${result.length} test associate entries:`, result);
  } catch (error) {
    console.error("Cleanup failed:", error);
  } finally {
    process.exit(0);
  }
}

run();
