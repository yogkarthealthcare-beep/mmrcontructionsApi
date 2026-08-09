import "../config/loadEnv.js";
import postgres from "postgres";

const host = process.env.DB_HOST || process.env.DATABASE_HOST || "66.116.248.35";
const port = process.env.DB_PORT || process.env.DATABASE_PORT || "5432";
const database = process.env.DB_NAME || process.env.DATABASE_NAME || "mmrconstructions";
const user = process.env.DB_USER || process.env.DATABASE_USER || "mmruser";
const password = process.env.DB_PASSWORD || process.env.DATABASE_PASSWORD || process.env.PGPASSWORD || "";

const sslMode = process.env.DB_SSL === "require" ? "require" : false;

async function runTest() {
  console.log("========================================");
  console.log("VPS POSTGRESQL CONNECTION TEST");
  console.log("========================================");
  console.log(`Host: ${host}`);
  console.log(`Port: ${port}`);
  console.log(`Database: ${database}`);
  console.log(`User: ${user}`);
  console.log("");

  let sql;
  try {
    const encodedUser = encodeURIComponent(user);
    const encodedPassword = password ? `:${encodeURIComponent(password)}` : "";
    const connectionString = `postgres://${encodedUser}${encodedPassword}@${host}:${port}/${database}`;

    sql = postgres(connectionString, {
      connect_timeout: 5,
      max: 1,
      ssl: sslMode,
      onnotice: () => {}
    });

    // 1. SELECT 1 Test
    const selectOneRes = await sql`SELECT 1 AS test`;
    const selectOneOk = selectOneRes && selectOneRes[0] && selectOneRes[0].test === 1;

    // 2. Info Query Test
    const infoRes = await sql`SELECT current_database() as db, current_user as usr, version() as ver`;
    const dbInfo = infoRes[0];

    console.log("Connection: SUCCESS\n");
    console.log(`Database: ${dbInfo.db}`);
    console.log(`User: ${dbInfo.usr}`);
    console.log(`PostgreSQL Version: ${dbInfo.ver}`);
    console.log("");
    console.log(`SELECT 1: ${selectOneOk ? "SUCCESS" : "FAILED"}`);
    console.log("");
    console.log("========================================");
    console.log("VPS DATABASE CONNECTION IS WORKING");
    console.log("========================================");

    await sql.end();
    process.exit(0);
  } catch (error) {
    console.log("Connection: FAILED");
    console.log("");
    console.log("Exact Error Details:");
    console.log(error.message || error);
    console.log("");
    console.log("========================================");
    console.log("DIAGNOSIS & ANALYSIS:");
    console.log("========================================");

    const msg = String(error.message || "").toLowerCase();

    if (msg.includes("econnrefused") || msg.includes("connection refused")) {
      console.log("- Reason: Connection refused by VPS firewall or PostgreSQL is not listening on 0.0.0.0:5432.");
      console.log("- Fix: Ensure listen_addresses='*' in postgresql.conf and UFW allows 5432/tcp.");
    } else if (msg.includes("password authentication failed")) {
      console.log("- Reason: Port 5432 is open and accepting TCP connections, but the password provided for user '" + user + "' is incorrect.");
      console.log("- Fix: Verify the correct PostgreSQL password in your local .env file under DATABASE_PASSWORD / DB_PASSWORD.");
    } else if (msg.includes("no pg_hba.conf entry")) {
      console.log("- Reason: PostgreSQL rejected the connection due to pg_hba.conf IP restrictions.");
      console.log("- Fix: Add 'host " + database + " " + user + " <YOUR_PUBLIC_IP>/32 scram-sha-256' to /etc/postgresql/<ver>/main/pg_hba.conf and run 'sudo systemctl reload postgresql'.");
    } else if (msg.includes("ssl") || msg.includes("tls")) {
      console.log("- Reason: SSL/TLS handshake failed.");
      console.log("- Fix: Check if SSL is enabled on VPS PostgreSQL or toggle DB_SSL in .env.");
    } else if (msg.includes("database") && msg.includes("does not exist")) {
      console.log("- Reason: The database '" + database + "' does not exist on the PostgreSQL server.");
      console.log("- Fix: Run 'CREATE DATABASE " + database + ";' on VPS PostgreSQL.");
    } else if (msg.includes("role") && msg.includes("does not exist")) {
      console.log("- Reason: The user/role '" + user + "' does not exist on the PostgreSQL server.");
      console.log("- Fix: Run 'CREATE USER " + user + " WITH PASSWORD '...';' on VPS PostgreSQL.");
    } else {
      console.log("- General Network/Configuration Error. Verify host, port, credentials, and firewall.");
    }

    if (sql) {
      await sql.end().catch(() => {});
    }
    process.exit(1);
  }
}

runTest();
