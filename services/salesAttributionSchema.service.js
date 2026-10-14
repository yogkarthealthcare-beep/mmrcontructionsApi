/**
 * MMR Construction & Developers Pvt. Ltd.
 * Sales Attribution & Booking Hierarchy Schema Initialization
 *
 * Ensures all columns on users, bookings, and vw_sales_attribution view
 * exist idempotently in PostgreSQL upon server start or deployment.
 */

let attributionSchemaPromise = null;

export async function ensureSalesAttributionSchema(sql) {
  if (!attributionSchemaPromise) {
    attributionSchemaPromise = (async () => {
      console.log('[Schema] Checking and initializing sales attribution schema...');

      // 1. Extend users table
      await sql.unsafe(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id INTEGER;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_source VARCHAR(50);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_set_at TIMESTAMPTZ;
        CREATE INDEX IF NOT EXISTS idx_users_referred_by_user_id ON users(referred_by_user_id);
      `);

      // 2. Extend bookings table
      await sql.unsafe(`
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booked_by_user_id INTEGER;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sold_by_user_id INTEGER;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_user_id INTEGER;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_type VARCHAR(40) NOT NULL DEFAULT 'CUSTOMER_SELF';
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_approval_status VARCHAR(40) NOT NULL DEFAULT 'NotRequired';
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_approved_by INTEGER;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_approved_at TIMESTAMPTZ;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_rejection_reason TEXT;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS associate_approval_overridden BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS workflow_status VARCHAR(80) DEFAULT 'Booking Initiated';
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS base_price NUMERIC(14,2) DEFAULT 0;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS advance_amount NUMERIC(14,2) DEFAULT 0;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC(14,2) DEFAULT 0;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_date TIMESTAMPTZ DEFAULT NOW();
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_type VARCHAR(50) DEFAULT 'FullPayment';
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS queue_position INTEGER DEFAULT 1;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(100) DEFAULT 'Cash / Bank';
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS required_booking_amount NUMERIC(14,2) DEFAULT 0;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS installment_plan_id INTEGER;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS plan_snapshot JSONB;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS part_wise_deadline_at TIMESTAMPTZ;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_due BOOLEAN DEFAULT FALSE;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_reason TEXT;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_marked_at TIMESTAMPTZ;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_marked_by_admin_id INTEGER;

        CREATE INDEX IF NOT EXISTS idx_bookings_booked_by_user_id ON bookings(booked_by_user_id);
        CREATE INDEX IF NOT EXISTS idx_bookings_sold_by_user_id ON bookings(sold_by_user_id);
        CREATE INDEX IF NOT EXISTS idx_bookings_associate_user_id ON bookings(associate_user_id);
        CREATE INDEX IF NOT EXISTS idx_bookings_assoc_approval_status ON bookings(associate_approval_status);
        CREATE INDEX IF NOT EXISTS idx_bookings_queue_position ON bookings(queue_position);
        CREATE INDEX IF NOT EXISTS idx_bookings_plot_id ON bookings(plot_id);
      `);

      // 2b. Ensure plots table has required columns for reporting
      await sql.unsafe(`
        ALTER TABLE plots ADD COLUMN IF NOT EXISTS sold_price NUMERIC(14,2);
        ALTER TABLE plots ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ;
        ALTER TABLE plots ADD COLUMN IF NOT EXISTS plot_status VARCHAR(50) DEFAULT 'Vacant';
        ALTER TABLE plots ADD COLUMN IF NOT EXISTS plot_area NUMERIC(12,2) DEFAULT 0;
        ALTER TABLE plots ADD COLUMN IF NOT EXISTS base_price NUMERIC(14,2) DEFAULT 0;
        ALTER TABLE plots ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
      `).catch(() => {});

      // 2c. Ensure auxiliary workflow tables exist
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS registry_records (
          registry_id SERIAL PRIMARY KEY,
          booking_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          plot_id INTEGER NOT NULL,
          registry_status VARCHAR(50) DEFAULT 'Completed',
          registry_no VARCHAR(100),
          registry_date DATE,
          mutation_date DATE,
          possession_date DATE,
          document_path VARCHAR(500),
          final_sold_price DECIMAL(14, 2),
          remarks TEXT,
          created_by_admin_id INTEGER,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_registry_records_booking_id ON registry_records(booking_id);
        CREATE INDEX IF NOT EXISTS idx_registry_records_plot_id ON registry_records(plot_id);
        CREATE INDEX IF NOT EXISTS idx_registry_records_user_id ON registry_records(user_id);

        CREATE TABLE IF NOT EXISTS booking_workflow_settings (
          id SERIAL PRIMARY KEY,
          part_wise_deadline_months INTEGER DEFAULT 3,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        INSERT INTO booking_workflow_settings (id, part_wise_deadline_months)
        VALUES (1, 3)
        ON CONFLICT (id) DO NOTHING;

        CREATE TABLE IF NOT EXISTS plot_status_history (
          id SERIAL PRIMARY KEY,
          plot_id INTEGER NOT NULL,
          old_status VARCHAR(50),
          new_status VARCHAR(50),
          changed_by_user_id INTEGER,
          admin_name VARCHAR(150),
          remarks TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE plot_status_history ADD COLUMN IF NOT EXISTS admin_name VARCHAR(150);
      `).catch(() => {});

      // 3. Create or replace vw_sales_attribution view
      try {
        await sql.unsafe(`DROP VIEW IF EXISTS vw_sales_attribution CASCADE;`);
        await sql.unsafe(`
          CREATE VIEW vw_sales_attribution AS
          SELECT
              b.booking_id,
              b.booking_serial,
              b.booking_date,
              b.booking_status,
              b.workflow_status,
              b.plot_id,
              p.plot_number,
              p.site_id,
              COALESCE(p.plot_area, 0) AS plot_area,
              COALESCE(b.base_price, p.sold_price, p.base_price, (b.advance_amount + b.remaining_balance), 0) AS sale_value,
              b.payment_type,
              (b.payment_type::TEXT = 'FullPayment') AS is_upfront,
              (
                  b.payment_type::TEXT = 'FullPayment' 
                  AND (b.workflow_status = 'Fully Paid' OR b.booking_status::TEXT = 'Confirmed')
                  AND (p.plot_status IS NULL OR p.plot_status::TEXT = 'Sold')
              ) AS is_reward_eligible,
              b.user_id AS buyer_user_id,
              buyer.full_name AS buyer_name,
              buyer.mobile_no AS buyer_mobile,
              buyer.member_id AS buyer_member_id,
              b.booked_by_user_id,
              booker.full_name AS booked_by_name,
              booker.mobile_no AS booked_by_mobile,
              booker.member_id AS booked_by_member_id,
              b.sold_by_user_id,
              seller.full_name AS sold_by_name,
              seller.mobile_no AS sold_by_mobile,
              seller.member_id AS sold_by_member_id,
              seller.user_type::TEXT AS sold_by_user_type,
              b.associate_user_id,
              assoc.full_name AS associate_name,
              assoc.mobile_no AS associate_mobile,
              assoc.member_id AS associate_member_id,
              b.booking_type,
              b.associate_approval_status,
              (b.booking_status::TEXT = 'Confirmed') AS is_confirmed_sale,
              (b.booking_type = 'SELF_PURCHASE') AS is_self_purchase,
              (b.sold_by_user_id IS NULL) AS is_company_direct,
              b.confirmed_at AS confirmed_at,
              s.site_name AS site_name
          FROM bookings b
          LEFT JOIN plots p ON p.plot_id = b.plot_id
          LEFT JOIN sites s ON s.site_id = p.site_id
          LEFT JOIN users buyer ON buyer.user_id = b.user_id
          LEFT JOIN users booker ON booker.user_id = b.booked_by_user_id
          LEFT JOIN users seller ON seller.user_id = b.sold_by_user_id
          LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id;
        `);
        console.log('[Schema] vw_sales_attribution view created successfully');
      } catch (viewErr) {
        console.error('[Schema] Failed to create vw_sales_attribution view:', viewErr.message);
      }

      // 4. Safe idempotent backfill for existing records without attribution
      await sql.unsafe(`
        UPDATE bookings
        SET booked_by_user_id = user_id
        WHERE booked_by_user_id IS NULL;

        UPDATE bookings
        SET booking_type = 'CUSTOMER_SELF'
        WHERE booking_type IS NULL;

        UPDATE bookings
        SET associate_approval_status = 'NotRequired'
        WHERE associate_approval_status IS NULL;

        UPDATE users
        SET referred_by_source = 'DIRECT_SIGNUP'
        WHERE referred_by_source IS NULL AND (sponsor_user_id IS NULL OR sponsor_user_id = 1);

        UPDATE users
        SET referred_by_source = 'REGISTRATION_CODE', referred_by_user_id = sponsor_user_id
        WHERE referred_by_source IS NULL AND sponsor_user_id IS NOT NULL AND sponsor_user_id <> 1;
      `).catch(() => {});

      console.log('[Schema] Sales attribution schema successfully synchronized ✅');
    })().catch((err) => {
      attributionSchemaPromise = null;
      console.error('[Schema] Sales attribution schema initialization warning:', err.message);
      throw err;
    });
  }

  return attributionSchemaPromise;
}

export default { ensureSalesAttributionSchema };
