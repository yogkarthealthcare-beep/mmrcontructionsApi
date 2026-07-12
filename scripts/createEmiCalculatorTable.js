import sql from "../db.js";

await sql`
  CREATE TABLE IF NOT EXISTS emi_calculator_master (
    id SERIAL PRIMARY KEY,
    plot_size VARCHAR(120) NOT NULL,
    plot_price NUMERIC(14,2) NOT NULL DEFAULT 0,
    down_payment NUMERIC(14,2) NOT NULL DEFAULT 0,
    loan_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    interest_rate NUMERIC(8,2) NOT NULL DEFAULT 0,
    tenure_months INTEGER NOT NULL DEFAULT 0,
    monthly_emi NUMERIC(14,2) NOT NULL DEFAULT 0,
    processing_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

await sql`CREATE INDEX IF NOT EXISTS idx_emi_calculator_active_order ON emi_calculator_master(is_active, display_order, id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_emi_calculator_plot_size ON emi_calculator_master(plot_size)`;

const [table] = await sql`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name = 'emi_calculator_master'`;

const columns = await sql`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'emi_calculator_master'
  ORDER BY ordinal_position`;

console.log(JSON.stringify({ table: table?.table_name || null, columns }, null, 2));
await sql.end();
