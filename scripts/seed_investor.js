import sql from "../db.js";

async function run() {
  try {
    // 1. Ensure sequence exists for investors.id
    await sql`CREATE SEQUENCE IF NOT EXISTS investors_id_seq`;
    await sql`ALTER TABLE investors ALTER COLUMN id SET DEFAULT nextval('investors_id_seq')`;
    await sql`ALTER SEQUENCE investors_id_seq OWNED BY investors.id`;
    await sql`SELECT setval('investors_id_seq', COALESCE((SELECT MAX(id) FROM investors), 0) + 1, false)`;

    // 2. Check if investor exists
    const existing = await sql`SELECT * FROM investors WHERE name = 'Suraj Kumar Verma' AND is_deleted = FALSE`;
    if (existing.length === 0) {
      const [inserted] = await sql`
        INSERT INTO investors (name, profile_image_url, display_order, is_active, is_deleted)
        VALUES (
          'Suraj Kumar Verma',
          'https://api.mmrconstructions.in/uploads/investors/1/profile/mmr-constructions-investor-1-investorphoto-20260811-292982.png',
          1,
          TRUE,
          FALSE
        )
        RETURNING *`;
      console.log("Successfully inserted investor into investors table:", inserted);
    } else {
      console.log("Investor already exists in investors table:", existing[0]);
    }
  } catch (err) {
    console.error("Error seeding investor:", err);
  } finally {
    process.exit(0);
  }
}

run();
