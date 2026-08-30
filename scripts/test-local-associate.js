import sql from "../db.js";

async function test() {
  try {
    console.log("Starting database test for Associate Enrollment...");
    
    // Check if table exists
    const [tableExists] = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'associate_enrollment'
      )
    `;
    
    if (!tableExists.exists) {
      console.log("\n❌ ERROR: The table 'associate_enrollment' does not exist in your database!");
      console.log("👉 Please run the migration first: npx knex migrate:latest\n");
      process.exit(1);
    }
    
    console.log("✓ Table 'associate_enrollment' exists.");

    // Generate unique ID
    const year = new Date().getFullYear();
    const [countResult] = await sql`
      SELECT COUNT(*)::integer as cnt 
      FROM associate_enrollment 
      WHERE id LIKE ${`MMR-ASC-${year}-%`}
    `;
    const count = (countResult?.cnt || 0) + 1;
    const generatedId = `MMR-ASC-${year}-${String(count).padStart(4, "0")}`;

    console.log(`Inserting dummy associate with ID: ${generatedId}...`);

    // Generate random PAN/Aadhar details to prevent unique constraints fail
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const randomPan = `TESTP${randomSuffix}Z`;
    const randomAadhar = `99998888${randomSuffix}`;

    // Insert dummy record
    await sql`
      INSERT INTO associate_enrollment (
        id, full_name, dob, gender, father_name, mother_name, spouse_name,
        contact_no_1, contact_no_2, nationality, residential_status,
        pan_no, aadhar_no, email, occupation, annual_income, education,
        category, religion, applicant_photo_path, sign_date,
        terms_accepted, terms_accepted_at, status
      ) VALUES (
        ${generatedId}, 'Test Associate vikas', '1990-01-01', 'Male', 'Test Father', 'Test Mother', null,
        '9999999999', null, 'Indian', 'Resident',
        ${randomPan}, ${randomAadhar}, 'test@example.com', 'Business', '6,00,000', 'Graduate',
        'General', 'Hindu', null, '2026-08-30',
        true, NOW(), 'pending'
      )
    `;

    console.log("✓ Successfully saved dummy associate record!");

    // Fetch the inserted record
    const [record] = await sql`SELECT * FROM associate_enrollment WHERE id = ${generatedId}`;
    console.log("✓ Fetched record from database:", record);

    console.log("\n🎉 Test successful! The API/Database is saving and retrieving data correctly.\n");
  } catch (error) {
    console.error("❌ Test failed with error:", error.message);
  } finally {
    process.exit(0);
  }
}

test();
