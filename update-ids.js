import sql from "./db.js";

async function runUpdate() {
  try {
    console.log("Connecting to database and updating member IDs...");
    
    // Update users.member_id
    const res1 = await sql`
      UPDATE users 
      SET member_id = REPLACE(REPLACE(REPLACE(member_id, '-C-', ''), '-A-', ''), '-ASC-', '')
      WHERE member_id LIKE 'MMR-%'
    `;
    console.log(`Updated ${res1.count || res1.length || 'many'} rows in users table (member_id)`);

    // Update users.invitation_code
    const res2 = await sql`
      UPDATE users 
      SET invitation_code = REPLACE(REPLACE(REPLACE(invitation_code, '-C-', ''), '-A-', ''), '-ASC-', '')
      WHERE invitation_code LIKE 'MMR-%'
    `;
    console.log(`Updated ${res2.count || res2.length || 'many'} rows in users table (invitation_code)`);

    console.log("Update completed successfully!");
  } catch (error) {
    console.error("Error running update:", error);
  } finally {
    process.exit(0);
  }
}

runUpdate();
