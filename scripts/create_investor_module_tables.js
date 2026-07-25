import sql from "../db.js";

export async function createInvestorModuleTables() {
  try {
    console.log("[DB] Ensuring PostgreSQL extensions...");
    await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
    await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;

    console.log("[DB] Creating investor_users table...");
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
        available_balance NUMERIC(12,2) DEFAULT 0.00,
        total_investment NUMERIC(12,2) DEFAULT 0.00,
        total_deposits NUMERIC(12,2) DEFAULT 0.00,
        total_withdrawals NUMERIC(12,2) DEFAULT 0.00,
        status VARCHAR(50) DEFAULT 'pending',
        is_verified BOOLEAN DEFAULT false,
        profile_picture_url TEXT,
        reset_otp VARCHAR(10),
        reset_otp_expires TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    console.log("[DB] Creating investor_deposits table...");
    await sql`
      CREATE TABLE IF NOT EXISTS investor_deposits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL,
        payment_method VARCHAR(100) NOT NULL,
        transaction_reference VARCHAR(255) NOT NULL,
        payment_screenshot_url TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        admin_remarks TEXT,
        approved_by INTEGER,
        approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    console.log("[DB] Creating investor_withdrawals table...");
    await sql`
      CREATE TABLE IF NOT EXISTS investor_withdrawals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL,
        bank_name VARCHAR(255) NOT NULL,
        account_number VARCHAR(100) NOT NULL,
        ifsc_code VARCHAR(50) NOT NULL,
        remarks TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        admin_remarks TEXT,
        approved_by INTEGER,
        approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    console.log("[DB] Creating investor_transactions table...");
    await sql`
      CREATE TABLE IF NOT EXISTS investor_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE,
        transaction_id VARCHAR(100) UNIQUE NOT NULL,
        type VARCHAR(50) NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        status VARCHAR(50) NOT NULL,
        payment_method VARCHAR(100),
        reference_number VARCHAR(255),
        remarks TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    console.log("[DB] Creating indexes for investor module...");
    await sql`CREATE INDEX IF NOT EXISTS idx_investor_users_email ON investor_users(email)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_investor_users_mobile ON investor_users(mobile_number)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_investor_deposits_investor_id ON investor_deposits(investor_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_investor_withdrawals_investor_id ON investor_withdrawals(investor_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_investor_transactions_investor_id ON investor_transactions(investor_id)`;

    console.log("[DB] Investor Module tables created successfully!");
  } catch (error) {
    console.error("[DB Error] Failed to create investor module tables:", error);
    throw error;
  }
}

// Execute directly if run via script command
if (process.argv[1]?.includes("create_investor_module_tables.js")) {
  createInvestorModuleTables()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
