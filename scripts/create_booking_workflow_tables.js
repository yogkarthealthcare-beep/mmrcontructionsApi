import "../config/loadEnv.js";
import sql from "../db.js";

try {
  await sql`
    CREATE TABLE IF NOT EXISTS booking_workflow_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      minimum_booking_amount NUMERIC(14,2) NOT NULL DEFAULT 50000,
      first_emi_amount NUMERIC(14,2) NOT NULL DEFAULT 10000,
      booking_formula VARCHAR(80) NOT NULL DEFAULT 'minimum_booking_amount + first_emi_amount',
      plot_lock_minutes INTEGER NOT NULL DEFAULT 20 CHECK (plot_lock_minutes BETWEEN 5 AND 1440),
      appointment_days_ahead INTEGER NOT NULL DEFAULT 14 CHECK (appointment_days_ahead BETWEEN 1 AND 90),
      appointment_slot_minutes INTEGER NOT NULL DEFAULT 30 CHECK (appointment_slot_minutes BETWEEN 15 AND 240),
      office_open_time TIME NOT NULL DEFAULT '10:00',
      office_close_time TIME NOT NULL DEFAULT '17:00',
      company_name VARCHAR(180) NOT NULL DEFAULT 'MMR Constructions & Developers Pvt. Ltd.',
      company_address TEXT,
      company_phone VARCHAR(30),
      company_email VARCHAR(180),
      updated_by_admin_id INTEGER REFERENCES admin_users(admin_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`
    INSERT INTO booking_workflow_settings (id)
    VALUES (1) ON CONFLICT (id) DO NOTHING`;

  await sql`
    CREATE TABLE IF NOT EXISTS user_kyc_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      status VARCHAR(30) NOT NULL DEFAULT 'Not Submitted'
        CHECK (status IN ('Not Submitted','Submitted','Under Review','Approved','Rejected')),
      admin_remarks TEXT,
      submitted_at TIMESTAMPTZ,
      reviewed_at TIMESTAMPTZ,
      reviewed_by_admin_id INTEGER REFERENCES admin_users(admin_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await sql`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS review_status VARCHAR(30) NOT NULL DEFAULT 'Submitted'`;
  await sql`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS admin_remarks TEXT`;
  await sql`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS reupload_requested BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE user_documents DROP CONSTRAINT IF EXISTS user_documents_document_type_check`;
  await sql`
    ALTER TABLE user_documents ADD CONSTRAINT user_documents_document_type_check
    CHECK (document_type IN (
      'PANCard','AadharCard','Passport','DrivingLicense','AddressProof',
      'IdentityProof','ProfilePhoto','Other'
    ))`;

  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS workflow_status VARCHAR(50) NOT NULL DEFAULT 'Booking Initiated'`;
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20)`;
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS required_booking_amount NUMERIC(14,2)`;
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS minimum_booking_amount NUMERIC(14,2)`;
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS first_emi_amount NUMERIC(14,2)`;
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC(14,2)`;
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_order_id VARCHAR(180)`;
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_reference_id VARCHAR(180)`;
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_received_at TIMESTAMPTZ`;

  await sql`
    CREATE TABLE IF NOT EXISTS plot_booking_locks (
      lock_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      booking_id INTEGER REFERENCES bookings(booking_id) ON DELETE CASCADE,
      lock_token UUID NOT NULL DEFAULT gen_random_uuid(),
      status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active','Converted','Expired','Released')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_plot_booking_lock
    ON plot_booking_locks(plot_id) WHERE status = 'Active'`;
  await sql`CREATE INDEX IF NOT EXISTS idx_plot_booking_locks_user ON plot_booking_locks(user_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_plot_booking_locks_expiry ON plot_booking_locks(status, expires_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS booking_appointments (
      appointment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(booking_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      appointment_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'Scheduled'
        CHECK (status IN ('Scheduled','Rescheduled','Completed','Cancelled','Rejected')),
      payment_mode VARCHAR(30) NOT NULL DEFAULT 'Office Visit',
      reference_no VARCHAR(180),
      admin_remarks TEXT,
      rescheduled_by_admin_id INTEGER REFERENCES admin_users(admin_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_booking_appointments_slot ON booking_appointments(appointment_date, start_time, status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_booking_appointments_user ON booking_appointments(user_id, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS booking_payment_records (
      payment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('Online','Offline')),
      gateway_name VARCHAR(40),
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      status VARCHAR(30) NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending','Verification Pending','Paid','Rejected','Refunded')),
      order_id VARCHAR(180),
      gateway_order_id VARCHAR(180),
      gateway_payment_id VARCHAR(180),
      gateway_signature TEXT,
      reference_no VARCHAR(180),
      remarks TEXT,
      raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
      verified_by_admin_id INTEGER REFERENCES admin_users(admin_id),
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_payment_order ON booking_payment_records(order_id) WHERE order_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_booking_payment_records_booking ON booking_payment_records(booking_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_booking_payment_records_status ON booking_payment_records(status, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS booking_invoices (
      invoice_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      invoice_number VARCHAR(80) NOT NULL UNIQUE,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(booking_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      payment_id BIGINT REFERENCES booking_payment_records(payment_id),
      invoice_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_booking_invoices_user ON booking_invoices(user_id, generated_at DESC)`;

  await sql`CREATE INDEX IF NOT EXISTS idx_bookings_user_created ON bookings(user_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bookings_plot_status ON bookings(plot_id, booking_status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_user_documents_user_active ON user_documents(user_id, is_active, uploaded_at DESC)`;

  await sql`
    INSERT INTO user_kyc_profiles (user_id, status, submitted_at)
    SELECT u.user_id,
           CASE
             WHEN COUNT(d.document_id) FILTER (WHERE d.is_active) = 0 THEN 'Not Submitted'
             WHEN BOOL_AND(d.is_verified) FILTER (WHERE d.is_active) THEN 'Approved'
             ELSE 'Submitted'
           END,
           MAX(d.uploaded_at) FILTER (WHERE d.is_active)
    FROM users u
    LEFT JOIN user_documents d ON d.user_id = u.user_id
    GROUP BY u.user_id
    ON CONFLICT (user_id) DO NOTHING`;

  console.log("Booking workflow schema is ready.");
} finally {
  await sql.end();
}
