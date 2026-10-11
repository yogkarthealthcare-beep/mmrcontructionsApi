/**
 * Knex Migration: Sales Attribution, Booking Hierarchy & Two-Level Approval Schema
 * MMR Construction & Developers Pvt. Ltd.
 * 
 * Target Tables:
 * 1. users: adds referred_by_user_id (FK users), referred_by_source, referred_by_set_at
 * 2. bookings: adds booked_by_user_id, sold_by_user_id, associate_user_id,
 *              booking_type, associate_approval_status, associate_approved_by,
 *              associate_approved_at, associate_rejection_reason
 * 3. view: vw_sales_attribution
 * 4. triggers & helper functions: fn_resolve_associate, fn_bookings_attribution_fallback,
 *                                 fn_validate_users_referrer, fn_generate_invite_code, fn_on_user_approved
 */

export async function up(knex) {
  // Use SET LOCAL to isolate timeouts strictly to this transaction (prevents pool leak)
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  // ===========================================================================
  // 1. EXTEND USERS TABLE (Attribution & Direct Referrer)
  // ===========================================================================
  const hasUsers = await knex.schema.hasTable('users');
  if (hasUsers) {
    const hasReferredBy = await knex.schema.hasColumn('users', 'referred_by_user_id');
    if (!hasReferredBy) {
      await knex.schema.alterTable('users', (table) => {
        table.integer('referred_by_user_id').nullable()
          .references('user_id').inTable('users')
          .onDelete('RESTRICT');
        table.string('referred_by_source', 30).nullable();
        table.timestamp('referred_by_set_at', { useTz: true }).nullable();
        table.index(['referred_by_user_id'], 'idx_users_referred_by_user_id');
      });
    }

    // Add CHECK constraints on users table
    await knex.raw(`
      ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_referred_by_not_self;
      ALTER TABLE users ADD CONSTRAINT chk_users_referred_by_not_self 
        CHECK (referred_by_user_id IS NULL OR referred_by_user_id <> user_id);

      ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_referred_by_source;
      ALTER TABLE users ADD CONSTRAINT chk_users_referred_by_source 
        CHECK (referred_by_source IS NULL OR referred_by_source IN ('REGISTRATION_CODE', 'ADMIN_ASSIGNED', 'TEAM_MEMBER_SLOT', 'LEGACY_SPONSOR_INFERRED', 'ASSOCIATE_ENROLLMENT'));
    `);

    // Validation Trigger: Referrer must be Associate or Team Member
    await knex.raw(`
      CREATE OR REPLACE FUNCTION fn_validate_users_referrer()
      RETURNS TRIGGER AS $$
      DECLARE
        v_ref_type TEXT;
      BEGIN
        IF NEW.referred_by_user_id IS NOT NULL THEN
          IF NEW.referred_by_user_id = NEW.user_id THEN
            RAISE EXCEPTION 'User cannot refer themselves (user_id: %)', NEW.user_id;
          END IF;

          SELECT user_type::TEXT INTO v_ref_type FROM users WHERE user_id = NEW.referred_by_user_id;
          IF v_ref_type IS NULL THEN
            RAISE EXCEPTION 'Referrer user_id % does not exist', NEW.referred_by_user_id;
          END IF;

          IF v_ref_type NOT IN ('Associate', 'Team Member') THEN
            RAISE EXCEPTION 'Referrer must be an Associate or Team Member, but user_id % is %', NEW.referred_by_user_id, v_ref_type;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_validate_users_referrer ON users;
      CREATE TRIGGER trg_validate_users_referrer
      BEFORE INSERT OR UPDATE ON users
      FOR EACH ROW
      EXECUTE FUNCTION fn_validate_users_referrer();
    `);
  }

  // ===========================================================================
  // 2. INVITATION CODE GENERATION & TEAM MEMBER APPROVAL EXTENSION
  // ===========================================================================
  await knex.raw(`
    DROP FUNCTION IF EXISTS fn_generate_invite_code CASCADE;
    CREATE OR REPLACE FUNCTION fn_generate_invite_code()
    RETURNS VARCHAR AS $$
    DECLARE
      v_code VARCHAR(20);
      v_exists BOOLEAN;
    BEGIN
      LOOP
        v_code := 'MMR' || UPPER(SUBSTRING(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) FROM 1 FOR 6));
        SELECT EXISTS(SELECT 1 FROM users WHERE UPPER(invitation_code) = UPPER(v_code)) INTO v_exists;
        IF NOT v_exists THEN
          RETURN v_code;
        END IF;
      END LOOP;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION fn_on_user_approved()
    RETURNS TRIGGER AS $$
    BEGIN
        IF NEW.account_status = 'Active' AND (OLD.account_status IS NULL OR OLD.account_status <> 'Active') THEN
            IF NEW.member_id IS NULL THEN
                NEW.member_id := fn_generate_member_id(NEW.user_type);
            END IF;

            -- Extended: Generate invitation code for both Associate AND Team Member
            IF (NEW.user_type::TEXT = 'Associate' OR NEW.user_type::TEXT = 'Team Member') 
               AND (NEW.invitation_code IS NULL OR TRIM(NEW.invitation_code) = '') THEN
                NEW.invitation_code := fn_generate_invite_code();
            END IF;

            IF NEW.user_type::TEXT = 'Associate' THEN
                INSERT INTO associate_sales_tracker (associate_user_id)
                VALUES (NEW.user_id)
                ON CONFLICT (associate_user_id) DO NOTHING;

                INSERT INTO mlm_network (associate_user_id, sponsor_user_id, level)
                VALUES (
                    NEW.user_id,
                    NEW.sponsor_user_id,
                    CASE WHEN NEW.sponsor_user_id IS NULL THEN 1
                         ELSE COALESCE((SELECT level FROM mlm_network WHERE associate_user_id = NEW.sponsor_user_id), 0) + 1
                    END
                )
                ON CONFLICT (associate_user_id) DO NOTHING;
            END IF;
        END IF;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Auto-generate invitation codes for existing active Team Members who have none
  await knex.raw(`
    DO $$
    DECLARE
      tm_row RECORD;
      new_code VARCHAR(20);
    BEGIN
      FOR tm_row IN (
        SELECT user_id FROM users
        WHERE user_type::TEXT = 'Team Member'
          AND (invitation_code IS NULL OR TRIM(invitation_code) = '')
      ) LOOP
        new_code := fn_generate_invite_code();
        UPDATE users SET invitation_code = new_code WHERE user_id = tm_row.user_id;
      END LOOP;
    END $$;
  `);

  // Unique index on invitation_code (guarded against duplicates)
  await knex.raw(`
    DO $$
    DECLARE
      dup_count INT;
    BEGIN
      SELECT COUNT(*) INTO dup_count
      FROM (
        SELECT UPPER(invitation_code)
        FROM users
        WHERE invitation_code IS NOT NULL AND TRIM(invitation_code) <> ''
        GROUP BY UPPER(invitation_code)
        HAVING COUNT(*) > 1
      ) d;

      IF dup_count = 0 THEN
        EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_users_invitation_code ON users (UPPER(invitation_code)) WHERE invitation_code IS NOT NULL AND TRIM(invitation_code) <> ''''';
      ELSE
        RAISE NOTICE 'Skipping index uq_users_invitation_code due to % duplicates', dup_count;
      END IF;
    END $$;
  `);

  // ===========================================================================
  // 3. BACKFILL USERS (referred_by_user_id) - EVIDENCE-BASED ATTRIBUTION
  // ===========================================================================
  // Evidence Principle (Phase 1B):
  // - Only explicit, verifiable referrals receive attribution.
  // - Customers with sponsor_user_id = default_sponsor (User 1) remain NULL (Company Direct)
  //   because legacy register-quick automatically defaulted all empty codes to User 1, and
  //   syncMlmTreeAndReferrals() bulk-upserted referral_registrations indiscriminately.
  // - Genuine User 1 referrals are exported to 08_ambiguous_default_sponsor_customers.csv
  //   for manual admin confirmation via PATCH /api/admin/users/:id/referrer.
  // - Customers sponsored by Customers or Investors are strictly blocked from attribution.

  // Rule 1: From team_members table for Team Members (upline associate)
  // Note: TEAM_MEMBER_SLOT stores the Team Member's upline Associate leader in the user table,
  // NOT customer sales attribution. Customer attribution reports must filter on user_type = 'Customer'.
  await knex.raw(`
    UPDATE users u
    SET referred_by_user_id = tm.associate_id,
        referred_by_source = 'TEAM_MEMBER_SLOT',
        referred_by_set_at = COALESCE(tm.created_at, NOW())
    FROM team_members tm
    JOIN users assoc ON assoc.user_id = tm.associate_id
    WHERE u.user_id = tm.user_id
      AND tm.status IN ('approved', 'active', 'pending')
      AND assoc.user_type::TEXT = 'Associate'
      AND u.user_id <> tm.associate_id
      AND u.referred_by_user_id IS NULL
      AND (u.referred_by_source IS NULL OR u.referred_by_source <> 'ADMIN_ASSIGNED');
  `);

  // Rule 2: Explicit Non-Default Sponsors (sponsor_user_id <> default sponsor)
  await knex.raw(`
    WITH default_sponsor AS (
      SELECT COALESCE((
        SELECT user_id FROM users 
        WHERE LOWER(email) = 'mmrconstructions@hotmail.com' 
           OR mobile_no = '7071951011' 
           OR user_id = 1 
           OR member_id IN ('MMR00001', 'MMR-ASC-0001', 'MMR0001')
        ORDER BY user_id ASC LIMIT 1
      ), 1) AS def_id
    )
    UPDATE users u
    SET referred_by_user_id = u.sponsor_user_id,
        referred_by_source = 'LEGACY_SPONSOR_INFERRED',
        referred_by_set_at = COALESCE(u.registered_at, NOW())
    FROM users ref, default_sponsor ds
    WHERE ref.user_id = u.sponsor_user_id
      AND u.sponsor_user_id IS NOT NULL
      AND u.sponsor_user_id <> ds.def_id
      AND ref.user_type::TEXT IN ('Associate', 'Team Member')
      AND u.user_id <> u.sponsor_user_id
      AND u.referred_by_user_id IS NULL
      AND (u.referred_by_source IS NULL OR u.referred_by_source <> 'ADMIN_ASSIGNED');
  `);

  // Rule 3: Any customer with sponsor_user_id = default_sponsor, NULL, or ineligible sponsor type
  // (Customer/Investor) remains referred_by_user_id = NULL (Company Direct).

  // ===========================================================================
  // 4. EXTEND BOOKINGS TABLE (Attribution & Snapshot Columns)
  // ===========================================================================
  const hasBookings = await knex.schema.hasTable('bookings');
  if (hasBookings) {
    const hasBookedBy = await knex.schema.hasColumn('bookings', 'booked_by_user_id');
    if (!hasBookedBy) {
      await knex.schema.alterTable('bookings', (table) => {
        table.integer('booked_by_user_id').nullable()
          .references('user_id').inTable('users')
          .onDelete('SET NULL');
        table.integer('sold_by_user_id').nullable()
          .references('user_id').inTable('users')
          .onDelete('SET NULL');
        table.integer('associate_user_id').nullable()
          .references('user_id').inTable('users')
          .onDelete('SET NULL');
        table.string('booking_type', 40).notNullable().defaultTo('CUSTOMER_SELF');
        table.string('associate_approval_status', 40).notNullable().defaultTo('NotRequired');
        table.integer('associate_approved_by').nullable()
          .references('user_id').inTable('users')
          .onDelete('SET NULL');
        table.timestamp('associate_approved_at', { useTz: true }).nullable();
        table.text('associate_rejection_reason').nullable();

        table.index(['booked_by_user_id'], 'idx_bookings_booked_by_user_id');
        table.index(['sold_by_user_id'], 'idx_bookings_sold_by_user_id');
        table.index(['associate_user_id'], 'idx_bookings_associate_user_id');
        table.index(['booking_status', 'sold_by_user_id'], 'idx_bookings_status_sold_by');
        table.index(['booking_date'], 'idx_bookings_booking_date');
        table.index(['associate_approval_status'], 'idx_bookings_assoc_approval_status');
      });
    }

    // Booking CHECK constraints
    await knex.raw(`
      ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_booking_type;
      ALTER TABLE bookings ADD CONSTRAINT chk_bookings_booking_type
        CHECK (booking_type IN ('CUSTOMER_SELF', 'ON_BEHALF_BY_TEAM_MEMBER', 'ON_BEHALF_BY_ASSOCIATE', 'SELF_PURCHASE'));

      ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_assoc_approval;
      ALTER TABLE bookings ADD CONSTRAINT chk_bookings_assoc_approval
        CHECK (associate_approval_status IN ('NotRequired', 'Pending', 'Approved', 'Rejected', 'AutoApproved_CreatedByAssociate'));
    `);
  }

  // ===========================================================================
  // 5. HELPER FUNCTION: fn_resolve_associate(p_user_id)
  // ===========================================================================
  await knex.raw(`
    CREATE OR REPLACE FUNCTION fn_resolve_associate(p_user_id INT)
    RETURNS INTEGER AS $$
    DECLARE
      v_user_type TEXT;
      v_assoc_id INTEGER;
    BEGIN
      IF p_user_id IS NULL THEN
        RETURN NULL;
      END IF;

      SELECT user_type::TEXT INTO v_user_type FROM users WHERE user_id = p_user_id;
      IF v_user_type IS NULL THEN
        RETURN NULL;
      END IF;

      -- If seller is already an Associate, they are their own team leader
      IF v_user_type = 'Associate' THEN
        RETURN p_user_id;
      END IF;

      -- If seller is a Team Member, look up team_members table
      IF v_user_type = 'Team Member' THEN
        SELECT tm.associate_id::INTEGER INTO v_assoc_id
        FROM team_members tm
        WHERE tm.user_id = p_user_id
          AND tm.status IN ('approved', 'active', 'pending')
        ORDER BY tm.created_at DESC
        LIMIT 1;

        IF v_assoc_id IS NOT NULL THEN
          RETURN v_assoc_id;
        END IF;

        -- Fallback: users.sponsor_user_id
        SELECT u.sponsor_user_id INTO v_assoc_id
        FROM users u
        WHERE u.user_id = p_user_id;

        RETURN v_assoc_id;
      END IF;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql STABLE;
  `);

  // ===========================================================================
  // 6. SAFETY TRIGGER: trg_bookings_attribution_fallback (BEFORE INSERT)
  // ===========================================================================
  await knex.raw(`
    CREATE OR REPLACE FUNCTION fn_bookings_attribution_fallback()
    RETURNS TRIGGER AS $$
    DECLARE
      v_buyer_type TEXT;
      v_buyer_ref_id INTEGER;
    BEGIN
      -- 1. Default booked_by to user_id if null
      IF NEW.booked_by_user_id IS NULL THEN
        NEW.booked_by_user_id := NEW.user_id;
      END IF;

      SELECT user_type::TEXT, referred_by_user_id
      INTO v_buyer_type, v_buyer_ref_id
      FROM users WHERE user_id = NEW.user_id;

      -- 2. Attribution Logic:
      -- If buyer is Associate or Team Member buying for themselves (booked_by = user_id):
      -- It is strictly a SELF_PURCHASE (sold_by = buyer, associate = resolved upline)
      IF v_buyer_type IN ('Associate', 'Team Member') AND (NEW.booked_by_user_id = NEW.user_id) THEN
        NEW.booking_type := 'SELF_PURCHASE';
        NEW.sold_by_user_id := NEW.user_id;
        NEW.associate_user_id := fn_resolve_associate(NEW.user_id);
      ELSE
        -- For Customer buyers or On-Behalf bookings:
        IF NEW.booking_type IS NULL OR NEW.booking_type = '' THEN
          IF NEW.booked_by_user_id <> NEW.user_id THEN
            NEW.booking_type := 'ON_BEHALF_BY_ASSOCIATE';
          ELSE
            NEW.booking_type := 'CUSTOMER_SELF';
          END IF;
        END IF;

        -- For CUSTOMER_SELF: sold_by defaults exclusively from buyer's referred_by_user_id
        IF NEW.booking_type = 'CUSTOMER_SELF' AND NEW.sold_by_user_id IS NULL THEN
          NEW.sold_by_user_id := v_buyer_ref_id;
        END IF;

        -- Auto-resolve associate_user_id for customer sale if sold_by is known
        IF NEW.associate_user_id IS NULL AND NEW.sold_by_user_id IS NOT NULL THEN
          NEW.associate_user_id := fn_resolve_associate(NEW.sold_by_user_id);
        END IF;
      END IF;

      -- 3. Associate approval status defaulting (Phase 1 safety fallback)
      IF NEW.associate_approval_status IS NULL OR NEW.associate_approval_status = '' THEN
        IF NEW.booking_type = 'ON_BEHALF_BY_ASSOCIATE' OR (NEW.booking_type = 'SELF_PURCHASE' AND v_buyer_type = 'Associate') THEN
          NEW.associate_approval_status := 'AutoApproved_CreatedByAssociate';
          NEW.associate_approved_by := NEW.booked_by_user_id;
          NEW.associate_approved_at := NOW();
        ELSE
          NEW.associate_approval_status := 'NotRequired';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_bookings_attribution_fallback ON bookings;
    CREATE TRIGGER trg_bookings_attribution_fallback
    BEFORE INSERT ON bookings
    FOR EACH ROW
    EXECUTE FUNCTION fn_bookings_attribution_fallback();
  `);

  // ===========================================================================
  // 7. BACKFILL EXISTING BOOKINGS
  // ===========================================================================
  // Step A: Assisted bookings by Associate (derived from notes text)
  await knex.raw(`
    UPDATE bookings
    SET booking_type = 'ON_BEHALF_BY_ASSOCIATE',
        booked_by_user_id = (
          SELECT u.user_id FROM users u
          WHERE (bookings.notes ILIKE '%' || u.member_id || '%' OR bookings.notes ILIKE '%' || u.full_name || '%')
            AND u.user_type::TEXT = 'Associate'
          LIMIT 1
        ),
        sold_by_user_id = COALESCE(
          (SELECT buyer.referred_by_user_id FROM users buyer WHERE buyer.user_id = bookings.user_id),
          (SELECT u.user_id FROM users u WHERE (bookings.notes ILIKE '%' || u.member_id || '%' OR bookings.notes ILIKE '%' || u.full_name || '%') AND u.user_type::TEXT = 'Associate' LIMIT 1)
        ),
        associate_user_id = fn_resolve_associate(
          COALESCE(
            (SELECT buyer.referred_by_user_id FROM users buyer WHERE buyer.user_id = bookings.user_id),
            (SELECT u.user_id FROM users u WHERE (bookings.notes ILIKE '%' || u.member_id || '%' OR bookings.notes ILIKE '%' || u.full_name || '%') AND u.user_type::TEXT = 'Associate' LIMIT 1)
          )
        ),
        associate_approval_status = 'AutoApproved_CreatedByAssociate',
        updated_at = NOW()
    WHERE notes ILIKE '%Assisted booking by Associate%';
  `);

  // Step B: Self Purchase by Associate or Team Member
  await knex.raw(`
    UPDATE bookings
    SET booking_type = 'SELF_PURCHASE',
        booked_by_user_id = user_id,
        sold_by_user_id = user_id,
        associate_user_id = fn_resolve_associate(user_id),
        associate_approval_status = 'AutoApproved_CreatedByAssociate',
        updated_at = NOW()
    WHERE booking_type = 'CUSTOMER_SELF'
      AND EXISTS (
        SELECT 1 FROM users u
        WHERE u.user_id = bookings.user_id
          AND u.user_type::TEXT IN ('Associate', 'Team Member')
      );
  `);

  // Step C: Standard Customer Self bookings
  await knex.raw(`
    UPDATE bookings
    SET booking_type = 'CUSTOMER_SELF',
        booked_by_user_id = user_id,
        sold_by_user_id = (SELECT buyer.referred_by_user_id FROM users buyer WHERE buyer.user_id = bookings.user_id),
        associate_user_id = fn_resolve_associate((SELECT buyer.referred_by_user_id FROM users buyer WHERE buyer.user_id = bookings.user_id)),
        associate_approval_status = 'NotRequired',
        updated_at = NOW()
    WHERE booking_type = 'CUSTOMER_SELF' AND booked_by_user_id IS NULL;
  `);

  // ===========================================================================
  // 8. DATA CONSISTENCY CONSTRAINTS
  // ===========================================================================
  // ARCHITECTURAL NOTE (Phase 1B):
  // In the existing application workflow (POST /api/bookings and POST /booking/initiate),
  // multiple applications can legitimately be submitted for an 'InProcess' plot, and
  // are converted to 'Waitlisted' upon Admin confirmation (booking-workflow.routes.js:657).
  // A database UNIQUE index on plot_id would crash legitimate overlapping submissions with 23505.
  // Concurrency is therefore enforced in Phase 2 via application-level advisory locks
  // (pg_advisory_xact_lock) + SELECT FOR UPDATE returning friendly 409 errors.

  // Add consistency constraints (NOT VALID then VALIDATE)
  await knex.raw(`
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_self_purchase;
    ALTER TABLE bookings ADD CONSTRAINT chk_bookings_self_purchase
      CHECK (booking_type <> 'SELF_PURCHASE' OR (user_id = booked_by_user_id AND sold_by_user_id = user_id)) NOT VALID;
    ALTER TABLE bookings VALIDATE CONSTRAINT chk_bookings_self_purchase;

    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_customer_self;
    ALTER TABLE bookings ADD CONSTRAINT chk_bookings_customer_self
      CHECK (booking_type <> 'CUSTOMER_SELF' OR booked_by_user_id = user_id) NOT VALID;
    ALTER TABLE bookings VALIDATE CONSTRAINT chk_bookings_customer_self;

    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_on_behalf;
    ALTER TABLE bookings ADD CONSTRAINT chk_bookings_on_behalf
      CHECK (booking_type NOT LIKE 'ON_BEHALF%' OR booked_by_user_id IS NULL OR booked_by_user_id <> user_id) NOT VALID;
    ALTER TABLE bookings VALIDATE CONSTRAINT chk_bookings_on_behalf;
  `);

  // Ensure booking columns are character varying before creating view to prevent view dependency errors
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'bookings' AND column_name = 'booking_status' AND data_type <> 'character varying'
      ) THEN
        ALTER TABLE bookings ALTER COLUMN booking_status TYPE VARCHAR(60) USING booking_status::text;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'bookings' AND column_name = 'payment_type' AND data_type <> 'character varying'
      ) THEN
        ALTER TABLE bookings ALTER COLUMN payment_type TYPE VARCHAR(60) USING payment_type::text;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'bookings' AND column_name = 'payment_method' AND data_type <> 'character varying'
      ) THEN
        ALTER TABLE bookings ALTER COLUMN payment_method TYPE VARCHAR(60) USING payment_method::text;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'bookings' AND column_name = 'workflow_status' AND data_type <> 'character varying'
      ) THEN
        ALTER TABLE bookings ALTER COLUMN workflow_status TYPE VARCHAR(80) USING workflow_status::text;
      END IF;
    END $$;
  `);

  // ===========================================================================
  // 9. REPORTING VIEW: vw_sales_attribution
  // ===========================================================================
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
}

export async function down(knex) {
  // Use SET LOCAL to isolate timeouts strictly to this transaction (prevents pool leak)
  await knex.raw(`SET LOCAL lock_timeout = '5s';`);
  await knex.raw(`SET LOCAL statement_timeout = '60s';`);

  // 1. Drop reporting view
  await knex.raw(`DROP VIEW IF EXISTS vw_sales_attribution CASCADE;`);

  // 2. Drop triggers & constraints on bookings
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_bookings_attribution_fallback ON bookings;
    DROP FUNCTION IF EXISTS fn_bookings_attribution_fallback CASCADE;
    DROP FUNCTION IF EXISTS fn_resolve_associate CASCADE;

    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_self_purchase;
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_customer_self;
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_on_behalf;
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_booking_type;
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_assoc_approval;

    DROP INDEX IF EXISTS uq_active_plot_booking;
    DROP INDEX IF EXISTS idx_bookings_booked_by_user_id;
    DROP INDEX IF EXISTS idx_bookings_sold_by_user_id;
    DROP INDEX IF EXISTS idx_bookings_associate_user_id;
    DROP INDEX IF EXISTS idx_bookings_status_sold_by;
    DROP INDEX IF EXISTS idx_bookings_booking_date;
    DROP INDEX IF EXISTS idx_bookings_assoc_approval_status;
  `);

  // 3. Drop columns from bookings
  const hasBookings = await knex.schema.hasTable('bookings');
  if (hasBookings) {
    await knex.schema.alterTable('bookings', (table) => {
      table.dropColumn('booked_by_user_id');
      table.dropColumn('sold_by_user_id');
      table.dropColumn('associate_user_id');
      table.dropColumn('booking_type');
      table.dropColumn('associate_approval_status');
      table.dropColumn('associate_approved_by');
      table.dropColumn('associate_approved_at');
      table.dropColumn('associate_rejection_reason');
    }).catch(() => {});
  }

  // 4. Drop trigger & constraints on users
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_validate_users_referrer ON users;
    DROP FUNCTION IF EXISTS fn_validate_users_referrer CASCADE;

    ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_referred_by_not_self;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_referred_by_source;
    DROP INDEX IF EXISTS uq_users_invitation_code;
    DROP INDEX IF EXISTS idx_users_referred_by_user_id;
  `);

  // 5. Drop columns from users
  const hasUsers = await knex.schema.hasTable('users');
  if (hasUsers) {
    await knex.schema.alterTable('users', (table) => {
      table.dropColumn('referred_by_user_id');
      table.dropColumn('referred_by_source');
      table.dropColumn('referred_by_set_at');
    }).catch(() => {});
  }

  // 6. Revert fn_on_user_approved back to associate-only
  await knex.raw(`
    CREATE OR REPLACE FUNCTION fn_on_user_approved()
    RETURNS TRIGGER AS $$
    BEGIN
        IF NEW.account_status = 'Active' AND (OLD.account_status IS NULL OR OLD.account_status <> 'Active') THEN
            IF NEW.member_id IS NULL THEN
                NEW.member_id := fn_generate_member_id(NEW.user_type);
            END IF;

            IF NEW.user_type = 'Associate' AND NEW.invitation_code IS NULL THEN
                NEW.invitation_code := fn_generate_invite_code();
            END IF;

            IF NEW.user_type = 'Associate' THEN
                INSERT INTO associate_sales_tracker (associate_user_id)
                VALUES (NEW.user_id)
                ON CONFLICT (associate_user_id) DO NOTHING;

                INSERT INTO mlm_network (associate_user_id, sponsor_user_id, level)
                VALUES (
                    NEW.user_id,
                    NEW.sponsor_user_id,
                    CASE WHEN NEW.sponsor_user_id IS NULL THEN 1
                         ELSE COALESCE((SELECT level FROM mlm_network WHERE associate_user_id = NEW.sponsor_user_id), 0) + 1
                    END
                )
                ON CONFLICT (associate_user_id) DO NOTHING;
            END IF;
        END IF;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
}
