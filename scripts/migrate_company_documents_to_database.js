import "../config/loadEnv.js";
import sql from "../db.js";
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: (process.env.CLOUDINARY_CLOUD_NAME || "").trim(),
  api_key: (process.env.CLOUDINARY_API_KEY || "").trim(),
  api_secret: (process.env.CLOUDINARY_API_SECRET || "").trim(),
});

try {
  await sql`ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS file_data BYTEA`;
  await sql`ALTER TABLE company_documents ALTER COLUMN file_url DROP NOT NULL`;

  const documents = await sql`
    SELECT id, file_url
    FROM company_documents
    WHERE file_data IS NULL AND file_url IS NOT NULL
    ORDER BY id`;

  for (const document of documents) {
    if (!/^https?:\/\//i.test(document.file_url)) continue;
    let response = await fetch(document.file_url);
    if (!response.ok && document.file_url.includes("res.cloudinary.com")) {
      const match = document.file_url.match(/\/raw\/upload\/v\d+\/(.+)$/);
      const publicId = match?.[1];
      if (publicId) {
        const privateUrl = cloudinary.utils.private_download_url(publicId, "", {
          resource_type: "raw",
          type: "upload",
        });
        response = await fetch(privateUrl);
      }
    }
    if (!response.ok) {
      console.warn(`Skipped document ${document.id}: HTTP ${response.status}`);
      continue;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await sql`
      UPDATE company_documents
      SET file_data = ${buffer},
          file_url = ${`/api/company-documents/${document.id}/file`},
          file_public_id = NULL,
          updated_at = NOW()
      WHERE id = ${document.id}`;
    console.log(`Migrated document ${document.id} (${buffer.length} bytes).`);
  }
} finally {
  await sql.end();
}
