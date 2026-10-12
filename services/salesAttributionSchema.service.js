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

        CREATE INDEX IF NOT EXISTS idx_bookings_booked_by_user_id ON bookings(booked_by_user_id);
        CREATE INDEX IF NOT EXISTS idx_bookings_sold_by_user_id ON bookings(sold_by_user_id);
        CREATE INDEX IF NOT EXISTS idx_bookings_associate_user_id ON bookings(associate_user_id);
        CREATE INDEX IF NOT EXISTS idx_bookings_assoc_approval_status ON bookings(associate_approval_status);
      `);

      // 3. Create or replace vw_sales_attribution view
      await sql.unsafe(`
        DROP VIEW IF EXISTS vw_sales_attribution;
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
            p.plot_area AS plot_area,
            COALESCE(p.sold_price, p.base_price, 0) AS sale_value,
            b.payment_type,
            (b.payment_type::TEXT = 'FullPayment') AS is_upfront,
            (
                b.payment_type::TEXT = 'FullPayment' 
                AND b.workflow_status = 'Fully Paid' 
                AND p.plot_status::TEXT = 'Sold'
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
