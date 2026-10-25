import sql from "../db.js";

async function main() {
  try {
    console.log("Updating invoice_settings...");
    await sql`ALTER TABLE invoice_settings ADD COLUMN IF NOT EXISTS cin VARCHAR(100) DEFAULT 'U68200UP2025PTC229203'`;
    
    // Check if row 1 exists
    const [existing] = await sql`SELECT * FROM invoice_settings WHERE id = 1`;
    if (!existing) {
      await sql`
        INSERT INTO invoice_settings (
          id, company_name, cin, gst_number, address, phone, email, updated_at
        ) VALUES (
          1, 'MMR Construction & Developers', 'U68200UP2025PTC229203', '09AATCM6753A1Z5',
          'Tribhuvan Kheda, Sheshpur, Unnao, Uttar Pradesh, India, 209801',
          '+91 95111 19879', 'official@mmrconstructions.in', NOW()
        )
      `;
    } else {
      await sql`
        UPDATE invoice_settings SET
          company_name = 'MMR Construction & Developers',
          cin = 'U68200UP2025PTC229203',
          gst_number = '09AATCM6753A1Z5',
          address = 'Tribhuvan Kheda, Sheshpur, Unnao, Uttar Pradesh, India, 209801',
          phone = '+91 95111 19879',
          email = 'official@mmrconstructions.in',
          updated_at = NOW()
        WHERE id = 1
      `;
    }

    const [updated] = await sql`SELECT id, company_name, cin, gst_number, address, phone, email FROM invoice_settings WHERE id = 1`;
    console.log("SUCCESS! Invoice settings updated to:", updated);
  } catch (err) {
    console.error("Error updating invoice settings:", err);
  } finally {
    process.exit(0);
  }
}

main();
