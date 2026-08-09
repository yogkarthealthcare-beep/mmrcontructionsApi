import sql, { getDatabaseUrl, getDatabaseConfig, supabaseSql } from "../db.js";

async function testDualConnections() {
  console.log("=== Testing Dual Database Configuration ===");
  console.log("Primary VPS Config:", getDatabaseConfig());
  console.log("Primary VPS URL:", getDatabaseUrl().replace(/:[^:@]+@/, ":****@"));

  console.log("\nTesting Supabase Connection...");
  try {
    const res = await supabaseSql`SELECT 1 as test`;
    console.log("✅ Supabase Database Connection Successful! Result:", res[0]);
  } catch (err) {
    console.error("❌ Supabase Connection Error:", err.message);
  } finally {
    await supabaseSql.end();
    await sql.end();
  }
}

testDualConnections();
