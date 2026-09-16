import "../config/loadEnv.js";
import postgres from "postgres";

const host = process.env.DB_HOST || process.env.DATABASE_HOST || "66.116.248.35";
const port = process.env.DB_PORT || process.env.DATABASE_PORT || "5432";
const database = process.env.DB_NAME || process.env.DATABASE_NAME || "mmrconstructions";
const user = process.env.DB_USER || process.env.DATABASE_USER || "mmruser";
const password = process.env.DB_PASSWORD || process.env.DATABASE_PASSWORD || "";

async function main() {
  console.log("Connecting to PostgreSQL with SSL require/allow...");
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = password ? `:${encodeURIComponent(password)}` : "";
  const connectionString = `postgres://${encodedUser}${encodedPassword}@${host}:${port}/${database}`;

  const sql = postgres(connectionString, {
    connect_timeout: 10,
    max: 1,
    ssl: { rejectUnauthorized: false },
    onnotice: () => {}
  });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS receipts (
        id BIGSERIAL PRIMARY KEY,
        receipt_no VARCHAR(100) UNIQUE NOT NULL,
        serial_no INTEGER NOT NULL DEFAULT 1,
        plot_no VARCHAR(100),
        plot_area VARCHAR(100),
        customer_id BIGINT,
        customer_name VARCHAR(255) NOT NULL,
        mobile_no VARCHAR(25) NOT NULL,
        r_o_p VARCHAR(255),
        payment_type VARCHAR(50) NOT NULL DEFAULT 'Cash',
        payment_mode VARCHAR(100) NOT NULL DEFAULT 'Full Payment',
        cheque_no VARCHAR(100),
        cheque_date DATE,
        bank_name VARCHAR(255),
        receipt_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
        paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
        inward_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
        amount_depositor_name VARCHAR(255),
        advisor_name VARCHAR(255),
        advisor_mobile VARCHAR(25),
        full_payment_time TIMESTAMPTZ,
        receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
        plotting_place VARCHAR(255) NOT NULL DEFAULT '00, TRIBHUVAN KHEDA, SHESHPUR, Unnao, Uttar Pradesh - 209801, India',
        depositor_signature TEXT,
        authorized_signature TEXT,
        notes TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'Active',
        is_locked BOOLEAN NOT NULL DEFAULT TRUE,
        created_by BIGINT,
        updated_by BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_receipts_receipt_no ON receipts(receipt_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_serial_no ON receipts(serial_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_customer_name ON receipts(customer_name);
      CREATE INDEX IF NOT EXISTS idx_receipts_mobile_no ON receipts(mobile_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_plot_no ON receipts(plot_no);
      CREATE INDEX IF NOT EXISTS idx_receipts_receipt_date ON receipts(receipt_date);
      CREATE INDEX IF NOT EXISTS idx_receipts_customer_id ON receipts(customer_id);
      CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
      CREATE INDEX IF NOT EXISTS idx_receipts_created_at ON receipts(created_at DESC);
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS receipt_audit_log (
        id BIGSERIAL PRIMARY KEY,
        receipt_id BIGINT NOT NULL,
        receipt_no VARCHAR(100) NOT NULL,
        action VARCHAR(50) NOT NULL,
        performed_by BIGINT,
        performed_by_name VARCHAR(255),
        details JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_receipt_audit_receipt_id ON receipt_audit_log(receipt_id);
      CREATE INDEX IF NOT EXISTS idx_receipt_audit_receipt_no ON receipt_audit_log(receipt_no);
    `;

    console.log("SUCCESS: Both receipts and receipt_audit_log tables and indexes created successfully!");
    await sql.end();
    process.exit(0);
  } catch (err) {
    console.error("ERROR creating tables:", err);
    await sql.end();
    process.exit(1);
  }
}

main();
