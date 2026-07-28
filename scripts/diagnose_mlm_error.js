import sql from "../db.js";

async function diagnose() {
  console.log("==========================================");
  console.log("   DIAGNOSING MLM_NETWORK LEVEL NULL BUG  ");
  console.log("==========================================");

  try {
    const tableColumns = await sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'mlm_network'`;
    console.log("\n1. Columns of mlm_network:", tableColumns);

    const triggers = await sql`
      SELECT trigger_name, event_manipulation, event_object_table, action_statement
      FROM information_schema.triggers
      WHERE event_object_table = 'mlm_network' OR event_object_table = 'users' OR event_object_table = 'referral_registrations'`;
    console.log("\n2. Triggers on related tables:", triggers);

    const pgFunctions = await sql`
      SELECT routine_name, routine_definition
      FROM information_schema.routines
      WHERE routine_schema = 'public' AND (routine_name LIKE '%mlm%' OR routine_definition LIKE '%mlm_network%')`;
    console.log("\n3. Functions with mlm_network:", pgFunctions);

    // Let's test inserting into mlm_network with an un-networked sponsor_user_id
    console.log("\n4. Testing dummy insert into mlm_network...");
    const testAssocId = 999991;
    const testSponsorId = 999992;
    await sql`DELETE FROM mlm_network WHERE associate_user_id IN (${testAssocId}, ${testSponsorId})`;

    await sql`
      INSERT INTO mlm_network (associate_user_id, sponsor_user_id, level)
      VALUES (${testAssocId}, ${testSponsorId},
              CASE WHEN ${testSponsorId} IS NULL THEN 1
                   ELSE COALESCE((SELECT level FROM mlm_network WHERE associate_user_id = ${testSponsorId}), 0) + 1
              END) ON CONFLICT (associate_user_id) DO NOTHING`;

    console.log("   [SUCCESS] Dummy insert succeeded without error.");
    await sql`DELETE FROM mlm_network WHERE associate_user_id IN (${testAssocId}, ${testSponsorId})`;

  } catch (err) {
    console.error("\n[DIAGNOSTIC ERROR]:", err);
  } finally {
    process.exit(0);
  }
}

diagnose();
