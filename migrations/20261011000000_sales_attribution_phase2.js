/**
 * MMR Construction & Developers Pvt. Ltd.
 * Migration: Phase 2 Sales Attribution & Approval Extensions
 * 
 * Scope:
 * 1. Allow 'DIRECT_SIGNUP' in users.referred_by_source
 * 2. Add associate_approval_overridden (BOOLEAN NOT NULL DEFAULT false) to bookings
 * 3. Append confirmed_at and site_name to the end of vw_sales_attribution
 */

export async function up(knex) {
  // Use SET LOCAL to isolate timeouts strictly to this transaction (prevents pool leak)
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  // 1. Expand referred_by_source check constraint on users to include DIRECT_SIGNUP
  await knex.raw(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_referred_by_source;
    ALTER TABLE users ADD CONSTRAINT chk_users_referred_by_source 
      CHECK (referred_by_source IS NULL OR referred_by_source IN (
        'REGISTRATION_CODE', 'ADMIN_ASSIGNED', 'TEAM_MEMBER_SLOT', 
        'LEGACY_SPONSOR_INFERRED', 'ASSOCIATE_ENROLLMENT', 'DIRECT_SIGNUP'
      ));
  `);

  // 2. Add associate_approval_overridden to bookings
  const hasBookings = await knex.schema.hasTable('bookings');
  if (hasBookings) {
    const hasCol = await knex.schema.hasColumn('bookings', 'associate_approval_overridden');
    if (!hasCol) {
      await knex.schema.alterTable('bookings', (table) => {
        table.boolean('associate_approval_overridden').notNullable().defaultTo(false);
      });
    }
  }

  // 3. Update view vw_sales_attribution: append confirmed_at and site_name at the end
  await knex.raw(`
    CREATE OR REPLACE VIEW vw_sales_attribution AS
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
        booker.member_id AS booked_by_member_id,
        b.sold_by_user_id,
        seller.full_name AS sold_by_name,
        seller.member_id AS sold_by_member_id,
        seller.user_type::TEXT AS sold_by_user_type,
        b.associate_user_id,
        assoc.full_name AS associate_name,
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
    LEFT JOIN sites s ON s.site_id = COALESCE(p.site_id, b.site_id)
    LEFT JOIN users buyer ON buyer.user_id = b.user_id
    LEFT JOIN users booker ON booker.user_id = b.booked_by_user_id
    LEFT JOIN users seller ON seller.user_id = b.sold_by_user_id
    LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id;
  `);
}

export async function down(knex) {
  // Use SET LOCAL to isolate timeouts strictly to this transaction (prevents pool leak)
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  // 1. Revert view vw_sales_attribution back to Phase 1 shape
  await knex.raw(`
    CREATE OR REPLACE VIEW vw_sales_attribution AS
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
        booker.member_id AS booked_by_member_id,
        b.sold_by_user_id,
        seller.full_name AS sold_by_name,
        seller.member_id AS sold_by_member_id,
        seller.user_type::TEXT AS sold_by_user_type,
        b.associate_user_id,
        assoc.full_name AS associate_name,
        assoc.member_id AS associate_member_id,
        b.booking_type,
        b.associate_approval_status,
        (b.booking_status::TEXT = 'Confirmed') AS is_confirmed_sale,
        (b.booking_type = 'SELF_PURCHASE') AS is_self_purchase,
        (b.sold_by_user_id IS NULL) AS is_company_direct
    FROM bookings b
    LEFT JOIN plots p ON p.plot_id = b.plot_id
    LEFT JOIN users buyer ON buyer.user_id = b.user_id
    LEFT JOIN users booker ON booker.user_id = b.booked_by_user_id
    LEFT JOIN users seller ON seller.user_id = b.sold_by_user_id
    LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id;
  `);

  // 2. Drop associate_approval_overridden from bookings
  const hasBookings = await knex.schema.hasTable('bookings');
  if (hasBookings) {
    const hasCol = await knex.schema.hasColumn('bookings', 'associate_approval_overridden');
    if (hasCol) {
      await knex.schema.alterTable('bookings', (table) => {
        table.dropColumn('associate_approval_overridden');
      });
    }
  }

  // 3. Revert referred_by_source constraint
  await knex.raw(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_referred_by_source;
    ALTER TABLE users ADD CONSTRAINT chk_users_referred_by_source 
      CHECK (referred_by_source IS NULL OR referred_by_source IN (
        'REGISTRATION_CODE', 'ADMIN_ASSIGNED', 'TEAM_MEMBER_SLOT', 
        'LEGACY_SPONSOR_INFERRED', 'ASSOCIATE_ENROLLMENT'
      ));
  `);
}
