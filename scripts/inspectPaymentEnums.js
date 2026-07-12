import sql from "../db.js";

const rows = await sql`
  SELECT pg_type.typname, pg_enum.enumlabel
  FROM pg_enum
  JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
  WHERE pg_type.typname LIKE '%payment%'
  ORDER BY pg_type.typname, pg_enum.enumsortorder`;

console.log(JSON.stringify(rows, null, 2));
await sql.end();
