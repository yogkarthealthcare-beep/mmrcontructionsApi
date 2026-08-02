import postgres from "postgres";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env") });

const connectionString = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/mmr_constructions";

console.log("Connecting to database for Invoice module schema creation...");

const sql = postgres(connectionString, {
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost") ? { rejectUnauthorized: false } : false,
});

async function main() {
  try {
    console.log("1. Creating invoice_settings table...");
    await sql`
      CREATE TABLE IF NOT EXISTS invoice_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        company_name VARCHAR(255) NOT NULL DEFAULT 'MMR Constructions & Developers',
        company_logo TEXT DEFAULT '',
        address TEXT DEFAULT 'Head Office: Main Road, Lucknow, Uttar Pradesh - 226001',
        phone VARCHAR(100) DEFAULT '+91 98765 43210 / +91 91234 56789',
        email VARCHAR(100) DEFAULT 'info@mmrconstructions.com',
        website VARCHAR(100) DEFAULT 'www.mmrconstructions.com',
        gst_number VARCHAR(50) DEFAULT '09AAAAA0000A1Z5',
        terms_and_conditions TEXT DEFAULT '1. All payments are subject to clearance.\n2. Plot allocation is subject to company guidelines and approval.\n3. Taxes and statutory charges are as per government norms.\n4. This is a system-generated invoice.',
        notes TEXT DEFAULT 'Thank you for choosing MMR Constructions & Developers.',
        bank_name VARCHAR(150) DEFAULT 'State Bank of India',
        account_no VARCHAR(100) DEFAULT '123456789012',
        ifsc_code VARCHAR(50) DEFAULT 'SBIN0001234',
        branch VARCHAR(100) DEFAULT 'Main Branch, Lucknow',
        upi_qr_url TEXT DEFAULT '',
        signature_url TEXT DEFAULT '',
        stamp_url TEXT DEFAULT '',
        invoice_prefix VARCHAR(20) DEFAULT 'MMR',
        invoice_starting_number INTEGER DEFAULT 1,
        invoice_footer TEXT DEFAULT 'System Generated Invoice - MMR Constructions & Developers',
        theme_color VARCHAR(30) DEFAULT '#14532d',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;

    // Seed default settings row if not present
    await sql`
      INSERT INTO invoice_settings (id, company_name)
      VALUES (1, 'MMR Constructions & Developers')
      ON CONFLICT (id) DO NOTHING`;

    console.log("2. Creating invoice_number_sequence table...");
    await sql`
      CREATE TABLE IF NOT EXISTS invoice_number_sequence (
        year INTEGER PRIMARY KEY,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;

    console.log("3. Creating invoices table...");
    await sql`
      CREATE TABLE IF NOT EXISTS invoices (
        invoice_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        invoice_number VARCHAR(100) NOT NULL UNIQUE,
        booking_id INTEGER UNIQUE REFERENCES bookings(booking_id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        associate_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        payment_id BIGINT REFERENCES booking_payment_records(payment_id) ON DELETE SET NULL,
        order_id VARCHAR(180),
        invoice_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        subtotal NUMERIC(14,2) DEFAULT 0,
        discount NUMERIC(14,2) DEFAULT 0,
        registration_charges NUMERIC(14,2) DEFAULT 0,
        development_charges NUMERIC(14,2) DEFAULT 0,
        other_charges NUMERIC(14,2) DEFAULT 0,
        grand_total NUMERIC(14,2) DEFAULT 0,
        paid_amount NUMERIC(14,2) DEFAULT 0,
        balance_amount NUMERIC(14,2) DEFAULT 0,
        payment_method VARCHAR(50) DEFAULT 'Online',
        payment_status VARCHAR(50) DEFAULT 'Paid',
        order_status VARCHAR(50) DEFAULT 'Completed',
        invoice_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        verification_token VARCHAR(100) DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;

    await sql`CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_invoices_associate ON invoices(associate_id, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_invoices_booking ON invoices(booking_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number)`;

    console.log("4. Creating invoice_audit_log table...");
    await sql`
      CREATE TABLE IF NOT EXISTS invoice_audit_log (
        log_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        invoice_id BIGINT REFERENCES invoices(invoice_id) ON DELETE CASCADE,
        invoice_number VARCHAR(100) NOT NULL,
        action VARCHAR(50) NOT NULL CHECK (action IN ('GENERATED', 'VIEWED', 'PRINTED', 'DOWNLOADED')),
        performed_by_id INTEGER,
        performed_by_role VARCHAR(30),
        ip_address VARCHAR(100) DEFAULT '',
        user_agent TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;

    await sql`CREATE INDEX IF NOT EXISTS idx_invoice_audit_invoice ON invoice_audit_log(invoice_id, created_at DESC)`;

    console.log("5. Populating invoices table for existing confirmed bookings...");
    const existingBookings = await sql`
      SELECT b.booking_id, b.booking_serial, b.user_id, b.remaining_balance,
             b.booking_status, b.payment_method, b.created_at, b.advance_amount, b.required_booking_amount,
             u.full_name, u.mobile_no, u.email,
             p.plot_number, p.plot_area, p.plot_category, p.base_price, p.monthly_emi, p.emi_tenure_months,
             s.site_name, s.site_id,
             assoc.user_id AS associate_user_id, assoc.full_name AS associate_name, assoc.mobile_no AS associate_mobile
      FROM bookings b
      JOIN users u ON u.user_id = b.user_id
      JOIN plots p ON p.plot_id = b.plot_id
      JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN referral_registrations r ON r.referred_user_id = b.user_id
      LEFT JOIN users assoc ON assoc.user_id = r.sponsor_user_id
      WHERE b.booking_status = 'Confirmed'
    `;

    console.log(`Found ${existingBookings.length} confirmed bookings.`);

    const currentYear = new Date().getFullYear();
    const [seqRow] = await sql`
      INSERT INTO invoice_number_sequence (year, last_sequence)
      VALUES (${currentYear}, 0)
      ON CONFLICT (year) DO UPDATE SET updated_at = NOW()
      RETURNING last_sequence`;

    let seq = seqRow ? seqRow.last_sequence : 0;

    for (const b of existingBookings) {
      const [existingInvoice] = await sql`SELECT invoice_id, invoice_number FROM invoices WHERE booking_id = ${b.booking_id}`;
      if (existingInvoice) {
        console.log(`Booking ID ${b.booking_id} already has invoice ${existingInvoice.invoice_number}`);
        continue;
      }

      seq++;
      const invoiceNumber = `MMR-${currentYear}-${String(seq).padStart(6, "0")}`;

      const associateId = b.associate_user_id || null;
      const associateName = b.associate_name || null;
      const associateMobile = b.associate_mobile || null;

      const totalPlotPrice = Number(b.base_price || (b.plot_area * 1000) || 0);
      const paidAmt = Number(b.required_booking_amount || b.advance_amount || b.booking_amount || 0);
      const remBalance = Number(b.remaining_balance || Math.max(0, totalPlotPrice - paidAmt));

      const invoiceDataSnapshot = {
        invoice_number: invoiceNumber,
        booking_id: b.booking_id,
        booking_serial: b.booking_serial || `BK-${b.booking_id}`,
        customer_name: b.full_name,
        mobile_no: b.mobile_no,
        email: b.email || "",
        site_name: b.site_name,
        plot_number: b.plot_number,
        plot_size: `${b.plot_area} ${b.plot_category || "Sq.Ft."}`,
        plot_area_sqft: Number(b.plot_area || 0),
        rate_per_sqft: b.plot_area ? Math.round(totalPlotPrice / b.plot_area) : 0,
        total_plot_price: totalPlotPrice,
        discount: 0,
        registration_charges: 0,
        other_charges: 0,
        grand_total: totalPlotPrice,
        paid_amount: paidAmt,
        balance_amount: remBalance,
        payment_method: b.payment_method || "Online",
        payment_status: "Paid",
        order_status: "Completed",
        booking_date: b.created_at,
        associate_id: associateId,
        associate_name: associateName,
        associate_mobile: associateMobile,
      };

      await sql`
        INSERT INTO invoices (
          invoice_number, booking_id, user_id, associate_id, order_id, invoice_date,
          subtotal, grand_total, paid_amount, balance_amount, payment_method,
          payment_status, order_status, invoice_data, verification_token
        ) VALUES (
          ${invoiceNumber}, ${b.booking_id}, ${b.user_id}, ${associateId}, ${b.booking_serial || `ORDER-${b.booking_id}`}, ${b.created_at},
          ${totalPlotPrice}, ${totalPlotPrice}, ${paidAmt}, ${remBalance}, ${b.payment_method || "Online"},
          'Paid', 'Completed', ${sql.json(invoiceDataSnapshot)}, ${invoiceNumber}
        )
      `;

      await sql`
        INSERT INTO invoice_audit_log (invoice_id, invoice_number, action, performed_by_role)
        SELECT invoice_id, invoice_number, 'GENERATED', 'SYSTEM' FROM invoices WHERE booking_id = ${b.booking_id}
      `;

      console.log(`Generated invoice ${invoiceNumber} for booking ${b.booking_id}`);
    }

    await sql`
      UPDATE invoice_number_sequence
      SET last_sequence = ${seq}, updated_at = NOW()
      WHERE year = ${currentYear}
    `;

    console.log("Invoice schema creation & data migration completed successfully.");
  } catch (err) {
    console.error("Migration error:", err);
  } finally {
    await sql.end();
  }
}

main();
