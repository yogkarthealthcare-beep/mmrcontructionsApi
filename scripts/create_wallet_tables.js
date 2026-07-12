import sql from "../db.js";

const addConstraint = async (tableName, constraintName, constraintSql) => {
  const [existing] = await sql`
    SELECT 1
    FROM pg_constraint
    WHERE conname = ${constraintName}
      AND conrelid = ${tableName}::regclass`;
  if (!existing) {
    await sql.unsafe(`ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${constraintSql}`);
  }
};

async function run() {
  try {
    console.log("Enabling UUID extension if not exists...");
    await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
    await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;

    console.log("Creating user_wallets table...");
    await sql`
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
      )
    `;

    console.log("Creating withdrawal_requests table...");
    await sql`
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
      )
    `;

    console.log("Creating wallet_transactions table...");
    await sql`
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
      )
    `;

    console.log("Creating wallet_audit_logs table...");
    await sql`
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
      )
    `;

    console.log("Adding relationships / foreign keys...");
    await addConstraint("user_wallets", "fk_user_wallets_user", "FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE");
    await addConstraint("withdrawal_requests", "fk_withdrawal_requests_user", "FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE");
    await addConstraint("withdrawal_requests", "fk_withdrawal_requests_wallet", "FOREIGN KEY (wallet_id) REFERENCES user_wallets(id) ON DELETE CASCADE");
    await addConstraint("withdrawal_requests", "fk_withdrawal_requests_approved_by", "FOREIGN KEY (approved_by) REFERENCES admin_users(admin_id) ON DELETE SET NULL");
    await addConstraint("withdrawal_requests", "fk_withdrawal_requests_released_by", "FOREIGN KEY (released_by) REFERENCES admin_users(admin_id) ON DELETE SET NULL");
    
    await addConstraint("wallet_transactions", "fk_wallet_transactions_wallet", "FOREIGN KEY (wallet_id) REFERENCES user_wallets(id) ON DELETE CASCADE");
    await addConstraint("wallet_transactions", "fk_wallet_transactions_user", "FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE");
    
    await addConstraint("wallet_audit_logs", "fk_wallet_audit_logs_user", "FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL");
    await addConstraint("wallet_audit_logs", "fk_wallet_audit_logs_admin", "FOREIGN KEY (admin_id) REFERENCES admin_users(admin_id) ON DELETE SET NULL");

    console.log("Adding status check constraints...");
    await addConstraint("withdrawal_requests", "chk_withdrawal_requests_status", "CHECK (status IN ('pending', 'approved', 'rejected', 'released', 'failed', 'cancelled'))");
    await addConstraint("wallet_transactions", "chk_wallet_transactions_status", "CHECK (status IN ('pending', 'success', 'failed', 'cancelled'))");
    await addConstraint("wallet_transactions", "chk_wallet_transactions_type", "CHECK (transaction_type IN ('credit', 'debit'))");

    console.log("Creating indexes for speed...");
    await sql`CREATE INDEX IF NOT EXISTS idx_user_wallets_user_id ON user_wallets (user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON wallet_transactions (wallet_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions (user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_wallet_transactions_payment_order_id ON wallet_transactions (payment_order_id)`;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_transactions_payment_order_id
      ON wallet_transactions (payment_order_id)
      WHERE payment_order_id IS NOT NULL
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_id ON withdrawal_requests (user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests (status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_wallet_audit_logs_user_id ON wallet_audit_logs (user_id)`;

    console.log("All wallet database tables initialized successfully.");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

run();
