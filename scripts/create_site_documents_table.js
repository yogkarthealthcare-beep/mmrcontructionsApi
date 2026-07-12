import sql from "../db.js";

async function run() {
  await sql`
    CREATE TABLE IF NOT EXISTS site_documents (
      document_id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
      document_name VARCHAR(180) NOT NULL,
      document_type VARCHAR(100),
      description TEXT,
      file_url TEXT NOT NULL,
      file_public_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_mime_type VARCHAR(100) NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      created_by_admin_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_site_documents_site_created
    ON site_documents(site_id, created_at DESC)`;
  console.log("site_documents table is ready.");
  await sql.end();
}

run().catch(async (error) => {
  console.error(error);
  await sql.end();
  process.exitCode = 1;
});
