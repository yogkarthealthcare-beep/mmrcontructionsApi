import "../config/loadEnv.js";
import sql from "../db.js";

const requiredTables = [
  "booking_workflow_settings",
  "user_kyc_profiles",
  "plot_booking_locks",
  "booking_appointments",
  "booking_payment_records",
  "booking_invoices",
];

try {
  const tables = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${requiredTables})`;
  const found = new Set(tables.map(row => row.table_name));
  for (const table of requiredTables) {
    if (!found.has(table)) throw new Error(`Missing workflow table: ${table}`);
  }

  const [settings] = await sql`
    SELECT minimum_booking_amount, first_emi_amount, plot_lock_minutes
    FROM booking_workflow_settings WHERE id = 1`;
  if (!settings) throw new Error("Booking workflow settings row is missing.");
  if (Number(settings.minimum_booking_amount) + Number(settings.first_emi_amount) <= 0) {
    throw new Error("Required booking payment is invalid.");
  }

  const bookingColumns = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bookings'
      AND column_name = ANY(${[
        "workflow_status", "payment_method", "required_booking_amount",
        "remaining_balance", "payment_order_id", "payment_reference_id",
      ]})`;
  if (bookingColumns.length !== 6) throw new Error("Booking workflow columns are incomplete.");

  console.log("Booking workflow schema regression checks passed.");
} finally {
  await sql.end();
}
