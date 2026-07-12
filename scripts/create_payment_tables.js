import sql from "../db.js";

async function run() {
  try {
    console.log("Enabling UUID extension if not exists...");
    await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
    await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;

    console.log("Creating payment_gateway_configs table...");
    await sql`
      CREATE TABLE IF NOT EXISTS payment_gateway_configs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        gateway_name VARCHAR(50) UNIQUE NOT NULL,
        display_name VARCHAR(100),
        is_enabled BOOLEAN DEFAULT false,
        is_default BOOLEAN DEFAULT false,
        allow_user_selection BOOLEAN DEFAULT true,
        fallback_enabled BOOLEAN DEFAULT false,
        priority INTEGER DEFAULT 1,
        status VARCHAR(50) DEFAULT 'inactive',
        environment_mode VARCHAR(50),
        public_key TEXT,
        encrypted_secret_key TEXT,
        encrypted_client_secret TEXT,
        encrypted_webhook_secret TEXT,
        callback_url TEXT,
        webhook_url TEXT,
        success_url TEXT,
        failure_url TEXT,
        cancel_url TEXT,
        min_customer_fund_amount NUMERIC(12,2) DEFAULT 100.00,
        min_associate_fund_amount NUMERIC(12,2) DEFAULT 100.00,
        extra_config JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Ensuring fund minimum columns exist...");
    await sql`ALTER TABLE payment_gateway_configs ADD COLUMN IF NOT EXISTS callback_url TEXT`;
    await sql`ALTER TABLE payment_gateway_configs ADD COLUMN IF NOT EXISTS webhook_url TEXT`;
    await sql`ALTER TABLE payment_gateway_configs ADD COLUMN IF NOT EXISTS success_url TEXT`;
    await sql`ALTER TABLE payment_gateway_configs ADD COLUMN IF NOT EXISTS failure_url TEXT`;
    await sql`ALTER TABLE payment_gateway_configs ADD COLUMN IF NOT EXISTS cancel_url TEXT`;
    await sql`ALTER TABLE payment_gateway_configs ADD COLUMN IF NOT EXISTS min_customer_fund_amount NUMERIC(12,2) DEFAULT 100.00`;
    await sql`ALTER TABLE payment_gateway_configs ADD COLUMN IF NOT EXISTS min_associate_fund_amount NUMERIC(12,2) DEFAULT 100.00`;

    console.log("Creating payment_transactions table...");
    await sql`
      CREATE TABLE IF NOT EXISTS payment_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id VARCHAR(255) UNIQUE NOT NULL,
        gateway_name VARCHAR(50) NOT NULL,
        transaction_id VARCHAR(255),
        amount NUMERIC(10,2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'INR',
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        customer_mobile VARCHAR(20),
        payment_status VARCHAR(50) DEFAULT 'pending',
        gateway_order_id VARCHAR(255),
        gateway_payment_id VARCHAR(255),
        gateway_signature TEXT,
        gateway_response JSONB DEFAULT '{}'::jsonb,
        failure_reason TEXT,
        created_by UUID,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Creating payment_logs table...");
    await sql`
      CREATE TABLE IF NOT EXISTS payment_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id VARCHAR(255),
        gateway_name VARCHAR(50),
        log_type VARCHAR(50),
        request_payload JSONB DEFAULT '{}'::jsonb,
        response_payload JSONB DEFAULT '{}'::jsonb,
        ip_address VARCHAR(100),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Creating payment_gateway_audit_logs table...");
    await sql`
      CREATE TABLE IF NOT EXISTS payment_gateway_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID,
        gateway_name VARCHAR(50),
        action_type VARCHAR(100),
        old_value JSONB DEFAULT '{}'::jsonb,
        new_value JSONB DEFAULT '{}'::jsonb,
        ip_address VARCHAR(100),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Creating indexes for performance...");
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_id ON payment_transactions (order_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions (payment_status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_logs_order_id ON payment_logs (order_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_gateway_configs_name ON payment_gateway_configs (gateway_name)`;

    console.log("Database schema successfully set up.");
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    await sql.end();
  }
}

run();
