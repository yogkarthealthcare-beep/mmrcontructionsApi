import "../config/loadEnv.js";
import sql from "../db.js";

try {
  await sql`
    CREATE TABLE IF NOT EXISTS company_documents (
      id SERIAL PRIMARY KEY,
      document_name VARCHAR(180) NOT NULL,
      document_name_hi VARCHAR(180),
      document_description TEXT,
      document_description_hi TEXT,
      document_type VARCHAR(100),
      document_type_hi VARCHAR(100),
      file_url TEXT NOT NULL,
      file_public_id TEXT,
      file_data BYTEA,
      file_type VARCHAR(20) NOT NULL,
      mime_type VARCHAR(120),
      original_file_name VARCHAR(255),
      file_size_bytes BIGINT,
      display_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_admin_id INTEGER,
      updated_by_admin_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_company_documents_active_order
    ON company_documents (is_active, display_order, id)`;
  await sql`ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS file_data BYTEA`;
  await sql`ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS document_name_hi VARCHAR(180)`;
  await sql`ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS document_description_hi TEXT`;
  await sql`ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS document_type_hi VARCHAR(100)`;
  await sql`ALTER TABLE company_documents ALTER COLUMN file_url DROP NOT NULL`;
  console.log("company_documents table is ready.");
} finally {
  await sql.end();
}
