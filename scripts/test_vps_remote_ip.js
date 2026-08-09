import postgres from "postgres";

const localPublicIp = "106.214.94.29";
const vpsIp = "66.116.248.35";
const vpsPort = 5432;
const vpsUser = "mmruser";
const vpsDb = "mmrconstructions";

console.log(`=== Remote VPS PostgreSQL Connectivity Test ===`);
console.log(`Local Public IP: ${localPublicIp}`);
console.log(`Target VPS IP: ${vpsIp}`);
console.log(`Target Port: ${vpsPort}`);

const password = process.env.DATABASE_PASSWORD || process.env.PGPASSWORD || "YOUR_VPS_DATABASE_PASSWORD";

if (password === "YOUR_VPS_DATABASE_PASSWORD") {
  console.log("\n[Notice]: Standard placeholder password used for connection test.");
}

async function testRemoteConnection() {
  const sql = postgres(`postgres://${encodeURIComponent(vpsUser)}:${encodeURIComponent(password)}@${vpsIp}:${vpsPort}/${vpsDb}`, {
    connect_timeout: 5,
    max: 1,
    ssl: false,
    onnotice: () => {}
  });

  try {
    const res = await sql`SELECT 1 as connected, current_database(), current_user`;
    console.log("\n✅ SUCCESS: Remote PostgreSQL database login successful!");
    console.log("Details:", res[0]);
  } catch (err) {
    console.error("\n❌ CONNECTION ERROR:", err.message);
    if (err.message.includes("CONNECT_TIMEOUT") || err.message.includes("ECONNREFUSED") || err.message.includes("ETIMEDOUT")) {
      console.log("Diagnosis: Port 5432 is unreachable/blocked from local IP " + localPublicIp + ".");
    } else if (err.message.includes("pg_hba.conf") || err.message.includes("no pg_hba.conf entry")) {
      console.log("Diagnosis: Port 5432 is open, but pg_hba.conf on VPS does not allow IP " + localPublicIp + ".");
    } else if (err.message.includes("password authentication failed")) {
      console.log("Diagnosis: Port 5432 is open and reachable! Authentication failed due to password.");
    }
  } finally {
    await sql.end().catch(() => {});
  }
}

testRemoteConnection();
