import sql from "../db.js";

const values = ["EMI", "FullPayment", "DownPayment"];

for (const value of values) {
  await sql.unsafe(`ALTER TYPE payment_type_enum ADD VALUE IF NOT EXISTS '${value}'`);
  console.log(`[payment_type_enum] verified: ${value}`);
}

const rows = await sql`
  SELECT enumlabel
  FROM pg_enum
  JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
  WHERE pg_type.typname = 'payment_type_enum'
  ORDER BY pg_enum.enumsortorder`;

console.log(JSON.stringify(rows, null, 2));
await sql.end();
