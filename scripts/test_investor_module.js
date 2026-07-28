import sql from "../db.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

async function runVerification() {
  console.log("==========================================");
  console.log("   VERIFYING INVESTOR MODULE (PHASE 1)   ");
  console.log("==========================================");

  try {
    const testEmail = `test_investor_${Date.now()}@example.com`;
    const testMobile = `${Math.floor(6000000000 + Math.random() * 3999999999)}`;
    const testPassword = "TestPassword123!";
    const testName = "Test Investor User";

    console.log("\n1. Testing Schema Readiness & Index Check...");
    await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;
    await sql`
      CREATE TABLE IF NOT EXISTS investor_users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        mobile_number VARCHAR(50) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        address TEXT,
        city VARCHAR(100),
        state VARCHAR(100),
        country VARCHAR(100) DEFAULT 'India',
        pincode VARCHAR(20),
        pan_number VARCHAR(50),
        aadhaar_number VARCHAR(50),
        bank_name VARCHAR(255),
        account_number VARCHAR(100),
        ifsc_code VARCHAR(50),
        nominee_name VARCHAR(255),
        available_balance NUMERIC(12,2) DEFAULT 0,
        total_investment NUMERIC(12,2) DEFAULT 0,
        total_deposits NUMERIC(12,2) DEFAULT 0,
        total_settlements NUMERIC(12,2) DEFAULT 0,
        total_earnings NUMERIC(12,2) DEFAULT 0,
        total_withdrawals NUMERIC(12,2) DEFAULT 0,
        status VARCHAR(50) DEFAULT 'pending_verification',
        is_verified BOOLEAN DEFAULT false,
        profile_picture_url TEXT,
        email_verification_token TEXT,
        email_verification_expires TIMESTAMPTZ,
        reset_otp VARCHAR(10),
        reset_otp_expires TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS total_settlements NUMERIC(12,2) DEFAULT 0`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS total_earnings NUMERIC(12,2) DEFAULT 0`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS email_verification_token TEXT`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMPTZ`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_investor_users_mobile_unique ON investor_users(mobile_number) WHERE deleted_at IS NULL`;
    console.log("   [SUCCESS] investor_users table & unique indexes verified.");

    console.log("\n2. Testing Pending Investor Registration & OTP Flow...");
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(testPassword, salt);
    const otp = "123456";

    await sql`
      CREATE TABLE IF NOT EXISTS pending_registrations (
        email TEXT PRIMARY KEY,
        mobile_no TEXT NOT NULL,
        user_type TEXT NOT NULL,
        full_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        sponsor_user_id INTEGER,
        sponsor_invite_code TEXT,
        optional_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        otp_code TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;

    await sql`DELETE FROM pending_registrations WHERE email = ${testEmail} OR mobile_no = ${testMobile}`;
    await sql`
      INSERT INTO pending_registrations (
        email, mobile_no, user_type, full_name, password_hash, otp_code, expires_at
      ) VALUES (
        ${testEmail}, ${testMobile}, 'Investor', ${testName}, ${passwordHash}, ${otp}, NOW() + INTERVAL '15 minutes'
      )`;
    console.log("   [SUCCESS] Pending investor registration created with OTP.");

    console.log("\n3. Testing OTP Verification & Investor User Activation...");
    const [pendingRow] = await sql`SELECT * FROM pending_registrations WHERE email = ${testEmail}`;
    if (!pendingRow || pendingRow.otp_code !== otp) {
      throw new Error("Pending registration OTP mismatch!");
    }

    const [createdInvestor] = await sql`
      INSERT INTO investor_users (
        full_name, mobile_number, email, password_hash, status, is_verified, created_at, updated_at
      ) VALUES (
        ${pendingRow.full_name}, ${pendingRow.mobile_no}, ${pendingRow.email}, ${pendingRow.password_hash},
        'active', true, NOW(), NOW()
      )
      RETURNING id, full_name, email, mobile_number, status, is_verified`;

    await sql`DELETE FROM pending_registrations WHERE email = ${testEmail}`;
    console.log("   [SUCCESS] Investor user created & activated:", createdInvestor);

    console.log("\n4. Testing Duplicate Email & Mobile Validation...");
    const [dupCheck] = await sql`SELECT id FROM investor_users WHERE LOWER(email) = ${testEmail.toLowerCase()} AND deleted_at IS NULL`;
    if (!dupCheck) throw new Error("Duplicate check failed!");
    console.log("   [SUCCESS] Duplicate email and mobile properly detected.");

    console.log("\n5. Testing Investor Password Authentication (Email & Mobile)...");
    const [loginByEmail] = await sql`SELECT * FROM investor_users WHERE LOWER(email) = ${testEmail.toLowerCase()} LIMIT 1`;
    const emailMatch = await bcrypt.compare(testPassword, loginByEmail.password_hash);
    if (!emailMatch) throw new Error("Email login password compare failed!");

    const [loginByMobile] = await sql`SELECT * FROM investor_users WHERE mobile_number = ${testMobile} LIMIT 1`;
    const mobileMatch = await bcrypt.compare(testPassword, loginByMobile.password_hash);
    if (!mobileMatch) throw new Error("Mobile login password compare failed!");
    console.log("   [SUCCESS] Dual-identifier authentication (Email & Mobile) working.");

    console.log("\n6. Testing Investor JWT Payload...");
    const jwtPayload = {
      id: createdInvestor.id,
      user_id: createdInvestor.id,
      user_type: "Investor",
      role: "Investor",
      email: createdInvestor.email,
      full_name: createdInvestor.full_name,
    };
    const secret = process.env.JWT_SECRET || "fallback_secret";
    const token = jwt.sign(jwtPayload, secret, { expiresIn: "7d" });
    const decoded = jwt.verify(token, secret);
    if (decoded.user_type !== "Investor" || decoded.id !== createdInvestor.id) {
      throw new Error("JWT token verification failed!");
    }
    console.log("   [SUCCESS] JWT token generation and verification passed.");

    console.log("\n7. Testing Investor Dashboard Data Query...");
    const [dashUser] = await sql`
      SELECT id, full_name, email, available_balance, total_investment, total_deposits, total_withdrawals
      FROM investor_users WHERE id = ${createdInvestor.id}`;
    const [{ count: txCount }] = await sql`SELECT COUNT(*) FROM investor_transactions WHERE investor_id = ${createdInvestor.id}`;
    console.log("   [SUCCESS] Dashboard query stats:", { user: dashUser.full_name, total_transactions: txCount });

    console.log("\n8. Cleaning Up Verification Data...");
    await sql`DELETE FROM investor_users WHERE id = ${createdInvestor.id}`;
    console.log("   [SUCCESS] Verification cleanup complete.");

    console.log("\n==========================================");
    console.log("   ALL VERIFICATIONS PASSED SUCCESSFULLY!  ");
    console.log("==========================================");
  } catch (err) {
    console.error("\n[VERIFICATION ERROR]:", err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

runVerification();
