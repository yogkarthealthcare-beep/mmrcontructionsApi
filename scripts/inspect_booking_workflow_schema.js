import "../config/loadEnv.js";
import sql from "../db.js";

const tables = ["users", "user_documents", "plots", "bookings", "payment_transactions"];

try {
  const columns = await sql`
    SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(${tables})
    ORDER BY table_name, ordinal_position`;

  const enums = await sql`
    SELECT t.typname, e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname IN (
      SELECT DISTINCT udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY(${tables})
    )
    ORDER BY t.typname, e.enumsortorder`;

  const constraints = await sql`
    SELECT
      tc.table_name,
      tc.constraint_name,
      tc.constraint_type,
      kcu.column_name
    FROM information_schema.table_constraints tc
    LEFT JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name = ANY(${tables})
    ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name`;

  console.log(JSON.stringify({ columns, enums, constraints }, null, 2));
} finally {
  await sql.end();
}
