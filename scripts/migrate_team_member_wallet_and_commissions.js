import sql from "../db.js";

/**
 * Migration: Team Member Wallet, Commissions & Settlement Schema
 * Ensures backward-compatible tables, columns, constraints and indexes exist.
 */
async function runMigration(dbInstance = sql) {
  console.log("=== STARTING MIGRATION: Team Member Wallet & Commissions Schema ===");

  // 1. Extensions
  await dbInstance.unsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`).catch(() => {});
  await dbInstance.unsafe(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`).catch(() => {});

  // 2. Enum value for user_type_enum if type exists
  await dbInstance.unsafe(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_type_enum') THEN
        BEGIN
          ALTER TYPE user_type_enum ADD VALUE IF NOT EXISTS 'Team Member';
        EXCEPTION
          WHEN duplicate_object THEN null;
        END;
      END IF;
    END$$;
  `).catch(e => console.warn("user_type_enum check:", e.message));

  // 3. user_wallets table
  await dbInstance.unsafe(`
    CREATE TABLE IF NOT EXISTS user_wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER NOT NULL UNIQUE,
      user_role VARCHAR(50) NOT NULL,
      available_balance NUMERIC(12,2) DEFAULT 0.00,
      pending_withdrawal_balance NUMERIC(12,2) DEFAULT 0.00,
      total_added_fund NUMERIC(12,2) DEFAULT 0.00,
      total_withdrawn NUMERIC(12,2) DEFAULT 0.00,
      total_commission NUMERIC(12,2) DEFAULT 0.00,
      currency VARCHAR(10) DEFAULT 'INR',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 4. withdrawal_requests table
  await dbInstance.unsafe(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER NOT NULL,
      user_role VARCHAR(50) NOT NULL,
      wallet_id UUID NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      bank_account_holder_name VARCHAR(255) NOT NULL,
      bank_account_number VARCHAR(100) NOT NULL,
      ifsc_code VARCHAR(50) NOT NULL,
      bank_name VARCHAR(255) NOT NULL,
      upi_id VARCHAR(255),
      status VARCHAR(50) DEFAULT 'pending',
      admin_remarks TEXT,
      rejection_reason TEXT,
      approved_by INTEGER,
      approved_at TIMESTAMP,
      released_by INTEGER,
      released_at TIMESTAMP,
      payout_reference_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 5. wallet_transactions table
  await dbInstance.unsafe(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_id UUID NOT NULL,
      user_id INTEGER NOT NULL,
      user_role VARCHAR(50) NOT NULL,
      transaction_type VARCHAR(50) NOT NULL,
      source VARCHAR(100) NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      balance_before NUMERIC(12,2) NOT NULL,
      balance_after NUMERIC(12,2) NOT NULL,
      payment_gateway VARCHAR(50),
      payment_order_id VARCHAR(255),
      payment_transaction_id VARCHAR(255),
      withdrawal_request_id UUID,
      status VARCHAR(50) NOT NULL,
      remarks TEXT,
      gateway_response JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 6. wallet_audit_logs table
  await dbInstance.unsafe(`
    CREATE TABLE IF NOT EXISTS wallet_audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER,
      admin_id INTEGER,
      action_type VARCHAR(100) NOT NULL,
      old_value JSONB DEFAULT '{}'::jsonb,
      new_value JSONB DEFAULT '{}'::jsonb,
      ip_address VARCHAR(100),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 7. Ensure bookings settlement columns exist
  await dbInstance.unsafe(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_status VARCHAR(30) DEFAULT 'Pending';
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_released_at TIMESTAMPTZ;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_released_by INT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_reference VARCHAR(100);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_cancelled_at TIMESTAMPTZ;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_cancelled_by INT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_cancel_reason TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_audit_log JSONB DEFAULT '[]'::jsonb;
  `);

  // 8. Ensure plot_order_settlements table exists
  await dbInstance.unsafe(`
    CREATE TABLE IF NOT EXISTS plot_order_settlements (
      settlement_id SERIAL PRIMARY KEY,
      booking_id INT NOT NULL,
      settlement_reference VARCHAR(100) UNIQUE NOT NULL,
      admin_id INT,
      admin_name VARCHAR(150),
      total_plot_price NUMERIC(14,2) DEFAULT 0,
      amount_received NUMERIC(14,2) DEFAULT 0,
      pool_amount NUMERIC(14,2) DEFAULT 0,
      total_distributed NUMERIC(14,2) DEFAULT 0,
      company_share NUMERIC(14,2) DEFAULT 0,
      recipient_breakdown JSONB,
      previous_status VARCHAR(30) DEFAULT 'Pending',
      new_status VARCHAR(30) DEFAULT 'Released',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 9. Add check constraints safely
  const addCheckConstraint = async (table, constraint, checkSql) => {
    try {
      await dbInstance.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = '${constraint}'
          ) THEN
            ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${checkSql};
          END IF;
        END$$;
      `);
    } catch (err) {
      console.warn(`Constraint ${constraint} notice:`, err.message);
    }
  };

  await addCheckConstraint("withdrawal_requests", "chk_withdrawal_requests_status", "CHECK (status IN ('pending', 'approved', 'rejected', 'released', 'failed', 'cancelled'))");
  await addCheckConstraint("wallet_transactions", "chk_wallet_transactions_status", "CHECK (status IN ('pending', 'success', 'failed', 'cancelled'))");
  await addCheckConstraint("wallet_transactions", "chk_wallet_transactions_type", "CHECK (transaction_type IN ('credit', 'debit'))");

  // 10. Create indexes for performance
  await dbInstance.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_user_wallets_user_id ON user_wallets (user_id);
    CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_id ON withdrawal_requests (user_id);
    CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests (status);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions (user_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON wallet_transactions (wallet_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_status ON wallet_transactions (status);
    CREATE INDEX IF NOT EXISTS idx_bookings_sold_by_user_id ON bookings (sold_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_settlement_status ON bookings (settlement_status);
  `);

  console.log("=== MIGRATION COMPLETED SUCCESSFULLY ===");
}

export default runMigration;

if (process.argv[1]?.endsWith("migrate_team_member_wallet_and_commissions.js")) {
  runMigration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
