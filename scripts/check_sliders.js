import 'dotenv/config';
import sql from '../db.js';

async function main() {
  try {
    const rows = await sql`
      SELECT id, title, subtitle, description, button_text, button_link, button_icon, 
             button2_text, button2_link, button2_icon, is_active, display_order 
      FROM home_sliders 
      ORDER BY display_order ASC, id ASC
    `;
    console.log("HOME SLIDERS COUNT:", rows.length);
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error("Error querying home_sliders:", err);
    process.exit(1);
  }
}

main();
