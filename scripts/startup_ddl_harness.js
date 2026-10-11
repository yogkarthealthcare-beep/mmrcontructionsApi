/**
 * MMR Construction & Developers Pvt. Ltd.
 * Startup DDL Harness for Phase 1C Testing
 * Replays all server.js startup DDL & schema reconciliation routines
 * touching users, bookings, plots, team_members, referral_registrations.
 */

export async function runServerStartupDDL(db) {
  const log = [];

  // 1. Plot Management Schema (ensurePlotManagementSchema & requirePlotManagementSchema)
  await db.exec(`
    ALTER TABLE plots ADD COLUMN IF NOT EXISTS unit_type VARCHAR(50) NOT NULL DEFAULT 'PLOT';
    ALTER TABLE plots ALTER COLUMN unit_type TYPE VARCHAR(50);
    ALTER TABLE plots DROP CONSTRAINT IF EXISTS chk_plots_unit_type;
    ALTER TABLE plots DROP CONSTRAINT IF EXISTS plots_unit_type_check;

    CREATE TABLE IF NOT EXISTS plot_polygon_coordinates (
      plot_id INTEGER PRIMARY KEY REFERENCES plots(plot_id) ON DELETE CASCADE,
      coordinates JSONB NOT NULL DEFAULT '[]'::jsonb,
      label_x NUMERIC,
      label_y NUMERIC,
      updated_by_admin_id INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS plot_polygon_history (
      id SERIAL PRIMARY KEY,
      plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE,
      old_coordinates JSONB NOT NULL DEFAULT '[]'::jsonb,
      new_coordinates JSONB NOT NULL DEFAULT '[]'::jsonb,
      changed_by_admin_id INTEGER,
      change_reason TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS plot_details_extended (
      plot_id INTEGER PRIMARY KEY REFERENCES plots(plot_id) ON DELETE CASCADE,
      size_label VARCHAR(120),
      width_ft NUMERIC,
      length_ft NUMERIC,
      facing_direction VARCHAR(80),
      is_corner_plot BOOLEAN DEFAULT FALSE,
      road_width_ft NUMERIC,
      features JSONB NOT NULL DEFAULT '[]'::jsonb,
      description TEXT,
      block_name VARCHAR(120),
      sector_name VARCHAR(120),
      updated_by_admin_id INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS plot_images (
      id SERIAL PRIMARY KEY,
      plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      image_path TEXT NOT NULL,
      caption TEXT,
      image_order INTEGER NOT NULL DEFAULT 0,
      uploaded_by_id INTEGER,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS plot_bulk_import_log (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
      imported_by_id INTEGER,
      original_filename TEXT,
      total_rows INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      error_details JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(30) NOT NULL DEFAULT 'Processing',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS plot_booking_history (
      id SERIAL PRIMARY KEY,
      plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE,
      booking_id INTEGER,
      user_id INTEGER,
      event_type VARCHAR(80) NOT NULL,
      event_note TEXT,
      triggered_by_admin INTEGER,
      triggered_by_user INTEGER,
      plot_status_at_time VARCHAR(40),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  log.push('requirePlotManagementSchema: OK');

  // 2. MLM Schema (requireMlmSchema in server.js)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS referral_registrations (
      id SERIAL PRIMARY KEY,
      sponsor_user_id INTEGER REFERENCES users(user_id),
      referred_user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
      sponsor_invite_code VARCHAR(80),
      registration_source VARCHAR(80) DEFAULT 'ReferralLink',
      referral_level INTEGER NOT NULL DEFAULT 1,
      status VARCHAR(30) NOT NULL DEFAULT 'Pending',
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mlm_network (
      id SERIAL PRIMARY KEY,
      associate_user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
      sponsor_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
      level INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mlm_tree_closure (
      id SERIAL PRIMARY KEY,
      ancestor_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      descendant_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      depth INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS associate_ranks (
      rank_id SERIAL PRIMARY KEY,
      rank_name VARCHAR(80) NOT NULL,
      min_direct_sales_gaj NUMERIC(12,2) NOT NULL DEFAULT 0,
      min_total_network_sales_gaj NUMERIC(12,2) NOT NULL DEFAULT 0,
      commission_multiplier NUMERIC(8,2) NOT NULL DEFAULT 1,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS associate_rank_history (
      id SERIAL PRIMARY KEY,
      associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      old_rank_id INTEGER REFERENCES associate_ranks(rank_id),
      new_rank_id INTEGER REFERENCES associate_ranks(rank_id),
      changed_reason TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS associate_sales_tracker (
      tracker_id SERIAL PRIMARY KEY,
      associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      total_gaj_sold NUMERIC(14,2) NOT NULL DEFAULT 0,
      total_commission_earned NUMERIC(14,2) NOT NULL DEFAULT 0,
      current_rank_id INTEGER REFERENCES associate_ranks(rank_id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS commission_rules (
      rule_id SERIAL PRIMARY KEY,
      commission_type VARCHAR(30) NOT NULL,
      level_depth INTEGER NOT NULL DEFAULT 1,
      plot_area_unit VARCHAR(30) NOT NULL DEFAULT 'gaj',
      amount_per_100_gaj NUMERIC(14,2) NOT NULL DEFAULT 0,
      duration_months INTEGER NOT NULL DEFAULT 144,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS commission_monthly_schedule (
      schedule_id SERIAL PRIMARY KEY,
      commission_id INTEGER,
      associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      booking_id INTEGER REFERENCES bookings(booking_id) ON DELETE CASCADE,
      month_no INTEGER NOT NULL,
      due_month DATE NOT NULL,
      amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'Pending',
      paid_at TIMESTAMPTZ,
      payment_reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS associate_status_history (
      id SERIAL PRIMARY KEY,
      associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      old_status VARCHAR(40),
      new_status VARCHAR(40) NOT NULL,
      reason TEXT,
      duration_days INTEGER,
      changed_by_admin_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Extended function: generates invite code for Associate and Team Member
    CREATE OR REPLACE FUNCTION fn_on_user_approved()
    RETURNS TRIGGER AS $$
    BEGIN
        IF NEW.account_status = 'Active' AND (OLD.account_status IS NULL OR OLD.account_status <> 'Active') THEN
            IF NEW.member_id IS NULL THEN
                NEW.member_id := fn_generate_member_id(NEW.user_type);
            END IF;

            IF (NEW.user_type::TEXT = 'Associate' OR NEW.user_type::TEXT = 'Team Member') 
               AND (NEW.invitation_code IS NULL OR TRIM(NEW.invitation_code) = '') THEN
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
  log.push('requireMlmSchema: OK');

  // 3. Commission Engine Schema (requireCommissionEngineSchema in server.js)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS commission_engine_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      commission_model TEXT NOT NULL DEFAULT 'FlatTeam'
        CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution', 'FlatTeam', 'TeamMemberModel')),
      maximum_levels INTEGER NOT NULL DEFAULT 3 CHECK (maximum_levels BETWEEN 1 AND 50),
      direct_percentage NUMERIC(8,4) NOT NULL DEFAULT 10 CHECK (direct_percentage BETWEEN 0 AND 100),
      upline_percentage NUMERIC(8,4) NOT NULL DEFAULT 2 CHECK (upline_percentage BETWEEN 0 AND 100),
      seller_percentage NUMERIC(8,4) NOT NULL DEFAULT 50 CHECK (seller_percentage BETWEEN 0 AND 100),
      equal_distribution_percentage NUMERIC(8,4) NOT NULL DEFAULT 50 CHECK (equal_distribution_percentage BETWEEN 0 AND 100),
      equal_distribution_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      distribution_scope TEXT NOT NULL DEFAULT 'TopAssociateNetwork',
      payment_mode_rules JSONB NOT NULL DEFAULT '{"full_payment":"instant","emi":"installment_wise"}'::jsonb,
      eligibility_rules JSONB NOT NULL DEFAULT '{"require_active_associate":true,"exclude_blacklisted":true,"minimum_plot_amount":0,"minimum_payment_amount":0}'::jsonb,
      bonus_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
      team_direct_percentage NUMERIC(8,4) NOT NULL DEFAULT 5 CHECK (team_direct_percentage BETWEEN 0 AND 100),
      team_passive_percentage NUMERIC(8,4) NOT NULL DEFAULT 0.5 CHECK (team_passive_percentage BETWEEN 0 AND 100),
      associate_leader_percentage NUMERIC(8,4) NOT NULL DEFAULT 0.5 CHECK (associate_leader_percentage BETWEEN 0 AND 100),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      version INTEGER NOT NULL DEFAULT 1,
      created_by_admin_id INTEGER,
      updated_by_admin_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS commission_engine_levels (
      id BIGSERIAL PRIMARY KEY,
      settings_id SMALLINT NOT NULL DEFAULT 1 REFERENCES commission_engine_settings(id) ON DELETE CASCADE,
      commission_model TEXT NOT NULL CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution', 'FlatTeam', 'TeamMemberModel')),
      level_no INTEGER NOT NULL CHECK (level_no BETWEEN 1 AND 50),
      percentage NUMERIC(8,4) NOT NULL CHECK (percentage BETWEEN 0 AND 100),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (settings_id, commission_model, level_no)
    );

    CREATE TABLE IF NOT EXISTS commission_engine_audit (
      audit_id BIGSERIAL PRIMARY KEY,
      settings_id SMALLINT NOT NULL,
      old_value JSONB NOT NULL,
      new_value JSONB NOT NULL,
      changed_by_admin_id INTEGER,
      reason TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION prevent_commission_engine_audit_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Commission engine audit history is immutable';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_commission_engine_audit_immutable ON commission_engine_audit;
    CREATE TRIGGER trg_commission_engine_audit_immutable
    BEFORE UPDATE OR DELETE ON commission_engine_audit
    FOR EACH ROW EXECUTE FUNCTION prevent_commission_engine_audit_mutation();
  `);
  log.push('requireCommissionEngineSchema: OK');

  // 4. Plot Allocation Schema (ensurePlotAllocationSchema in server.js)
  // Tested: Conditional column type conversion prevents 'cannot alter type of a column used by a view or rule'
  await db.exec(`
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

    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS plot_number VARCHAR(180);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS site_id INTEGER;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS plot_area NUMERIC(12,2) DEFAULT 0;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS base_price NUMERIC(14,2) DEFAULT 0;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_type VARCHAR(50) DEFAULT 'FullPayment';
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS workflow_status VARCHAR(80) DEFAULT 'Booking Initiated';
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS required_booking_amount NUMERIC(14,2) DEFAULT 0;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC(14,2) DEFAULT 0;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_date TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS registry_status VARCHAR(60);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS registry_date DATE;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS registry_document_url TEXT;
    ALTER TABLE bookings ALTER COLUMN plot_id DROP NOT NULL;

    ALTER TABLE plots ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Vacant';
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS father_husband_name VARCHAR(150);
    ALTER TABLE emi_schedules ADD COLUMN IF NOT EXISTS emi_id SERIAL;
    ALTER TABLE associate_sales_tracker ADD COLUMN IF NOT EXISTS tracker_id SERIAL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image VARCHAR(255);

    CREATE TABLE IF NOT EXISTS payment_vouchers (
      voucher_id SERIAL PRIMARY KEY,
      payment_ledger_id BIGINT
    );

    CREATE TABLE IF NOT EXISTS commission_transactions (
      commission_id SERIAL PRIMARY KEY,
      associate_user_id INTEGER,
      related_booking_id INTEGER,
      commission_type VARCHAR(50),
      gaj_sold NUMERIC(12,2) DEFAULT 0,
      gross_amount NUMERIC(14,2) DEFAULT 0,
      deduction_amount NUMERIC(14,2) DEFAULT 0,
      net_amount NUMERIC(14,2) DEFAULT 0,
      commission_month VARCHAR(20),
      commission_status VARCHAR(50) DEFAULT 'Pending',
      commission_event_id BIGINT,
      calculation_base NUMERIC(14,2) DEFAULT 0,
      source_type VARCHAR(50),
      source_reference VARCHAR(100),
      engine_version VARCHAR(50),
      seller_user_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS notification_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      sent_by_admin_id INTEGER,
      channel VARCHAR(60) DEFAULT 'InApp',
      title VARCHAR(255),
      message TEXT,
      is_read BOOLEAN DEFAULT FALSE,
      read_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS plot_status_history (
      history_id SERIAL PRIMARY KEY,
      plot_id INTEGER,
      old_status VARCHAR(50),
      new_status VARCHAR(50),
      reason TEXT,
      changed_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_documents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
      document_type VARCHAR(50),
      file_path VARCHAR(255),
      cloudinary_public_id VARCHAR(255),
      review_status VARCHAR(30) NOT NULL DEFAULT 'Submitted',
      admin_remarks TEXT,
      reupload_requested BOOLEAN NOT NULL DEFAULT FALSE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS booking_workflow_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      minimum_booking_amount NUMERIC(14,2) NOT NULL DEFAULT 50000,
      first_emi_amount NUMERIC(14,2) NOT NULL DEFAULT 10000,
      booking_formula VARCHAR(80) NOT NULL DEFAULT 'minimum_booking_amount + first_emi_amount',
      plot_lock_minutes INTEGER NOT NULL DEFAULT 20,
      appointment_days_ahead INTEGER NOT NULL DEFAULT 14,
      appointment_slot_minutes INTEGER NOT NULL DEFAULT 30,
      office_open_time TIME NOT NULL DEFAULT '10:00',
      office_close_time TIME NOT NULL DEFAULT '17:00',
      company_name VARCHAR(180) NOT NULL DEFAULT 'MMR Constructions & Developers Pvt. Ltd.',
      company_address TEXT,
      company_phone VARCHAR(30),
      company_email VARCHAR(180),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO booking_workflow_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS booking_appointments (
      appointment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(booking_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      appointment_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'Scheduled',
      payment_mode VARCHAR(30) NOT NULL DEFAULT 'Office Visit',
      reference_no VARCHAR(180),
      admin_remarks TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS booking_payment_records (
      payment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      payment_method VARCHAR(20) NOT NULL,
      gateway_name VARCHAR(40),
      amount NUMERIC(14,2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'Pending',
      order_id VARCHAR(180),
      gateway_order_id VARCHAR(180),
      gateway_payment_id VARCHAR(180),
      gateway_signature TEXT,
      reference_no VARCHAR(180),
      remarks TEXT,
      raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS workflow_status VARCHAR(50) NOT NULL DEFAULT 'Booking Initiated';
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS required_booking_amount NUMERIC(14,2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS minimum_booking_amount NUMERIC(14,2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS first_emi_amount NUMERIC(14,2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC(14,2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_order_id VARCHAR(180);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_reference_id VARCHAR(180);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_received_at TIMESTAMPTZ;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by_admin_id INTEGER;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

    ALTER TABLE plots ADD COLUMN IF NOT EXISTS plot_category VARCHAR(50);
    ALTER TABLE plots ADD COLUMN IF NOT EXISTS monthly_emi NUMERIC(14,2) DEFAULT 0;
    ALTER TABLE plots ADD COLUMN IF NOT EXISTS emi_tenure_months INTEGER DEFAULT 0;
    ALTER TABLE plots ADD COLUMN IF NOT EXISTS area_unit VARCHAR(30) DEFAULT 'Sq.Ft';

    ALTER TABLE plot_status_history ADD COLUMN IF NOT EXISTS changed_by_admin_id INTEGER;
    ALTER TABLE plot_status_history ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS email_config (
      id SERIAL PRIMARY KEY,
      key VARCHAR(100) UNIQUE,
      value TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      admin_id SERIAL PRIMARY KEY,
      role_id INTEGER DEFAULT 1,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO admin_users (admin_id, full_name, email, is_active)
    VALUES (1, 'Suraj Kumar Verma', 'admin@mmrconstructions.in', TRUE)
    ON CONFLICT (admin_id) DO NOTHING;

    ALTER TABLE associate_sales_tracker ADD COLUMN IF NOT EXISTS total_gaj_sold NUMERIC(12,2) DEFAULT 0;
    ALTER TABLE associate_sales_tracker ADD COLUMN IF NOT EXISTS total_commission_earned NUMERIC(14,2) DEFAULT 0;
    ALTER TABLE associate_sales_tracker ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

    -- Auxiliary columns & tables for server.js profile & notifications
    ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(20);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS father_name VARCHAR(150);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mother_name VARCHAR(150);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS spouse_name VARCHAR(150);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alternate_mobile VARCHAR(20);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS enrollment_status VARCHAR(50) DEFAULT 'Pending';

    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS father_husband_name VARCHAR(150);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS date_of_birth DATE;
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS gender VARCHAR(15);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS aadhar_no VARCHAR(20);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS pan_no VARCHAR(20);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS full_address TEXT;
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS photo_url VARCHAR(255);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS nominee_name VARCHAR(150);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS nominee_relation VARCHAR(80);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS nominee_age_dob VARCHAR(30);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS nominee_contact_no VARCHAR(20);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS bank_name VARCHAR(150);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS branch_name VARCHAR(150);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS account_no VARCHAR(50);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(20);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS applicant_signature_url VARCHAR(255);
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS associate_signature_url VARCHAR(255);

    CREATE TABLE IF NOT EXISTS associate_enrollment (
      id VARCHAR(50) PRIMARY KEY,
      user_id INTEGER,
      member_id VARCHAR(50),
      associate_id VARCHAR(50),
      full_name VARCHAR(150),
      father_name VARCHAR(150),
      dob DATE,
      gender VARCHAR(20),
      pan_no VARCHAR(20),
      aadhar_no VARCHAR(20),
      contact_no_1 VARCHAR(20),
      contact_1 VARCHAR(20),
      contact_no_2 VARCHAR(20),
      mobile_no VARCHAR(20),
      email VARCHAR(150),
      status VARCHAR(20) DEFAULT 'approved',
      applicant_photo_path TEXT,
      signature_path TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS associate_address (
      id SERIAL PRIMARY KEY,
      associate_id VARCHAR(50),
      address_type VARCHAR(20) DEFAULT 'permanent',
      local_address TEXT,
      city VARCHAR(100),
      state VARCHAR(100),
      pin_code VARCHAR(20)
    );

    CREATE TABLE IF NOT EXISTS associate_bank_details (
      id SERIAL PRIMARY KEY,
      associate_id VARCHAR(50),
      bank_name VARCHAR(150),
      branch_name VARCHAR(150),
      account_holder_name VARCHAR(150),
      account_no VARCHAR(50),
      ifsc_code VARCHAR(20)
    );

    CREATE TABLE IF NOT EXISTS associate_nominee (
      id SERIAL PRIMARY KEY,
      associate_id VARCHAR(50),
      nominee_name VARCHAR(150),
      relationship VARCHAR(80)
    );

    CREATE TABLE IF NOT EXISTS associate_sponsor (
      id SERIAL PRIMARY KEY,
      associate_id VARCHAR(50),
      sponsor_code VARCHAR(50),
      sponsor_name VARCHAR(150),
      sponsor_contact VARCHAR(20)
    );

    CREATE TABLE IF NOT EXISTS user_addresses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
      address_type VARCHAR(50) DEFAULT 'Permanent',
      address_line1 TEXT,
      city VARCHAR(100),
      state VARCHAR(100),
      pin_code VARCHAR(20)
    );

    CREATE TABLE IF NOT EXISTS user_bank_details (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
      bank_name VARCHAR(150),
      branch_name VARCHAR(150),
      account_holder_name VARCHAR(150),
      account_number VARCHAR(50),
      ifsc_code VARCHAR(20)
    );

    CREATE TABLE IF NOT EXISTS user_nominees (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
      nominee_name VARCHAR(150),
      relationship VARCHAR(80)
    );

    CREATE TABLE IF NOT EXISTS customer_enrollment_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER,
      application_no VARCHAR(50),
      applicant_name VARCHAR(150),
      fh_name VARCHAR(150),
      date_of_birth DATE,
      gender VARCHAR(10),
      marital_status VARCHAR(10),
      pan_no VARCHAR(10),
      aadhar_no VARCHAR(12),
      mobile_1 VARCHAR(15),
      mobile_2 VARCHAR(15),
      email_1 VARCHAR(150),
      present_address TEXT,
      present_city VARCHAR(100),
      present_state_pin VARCHAR(100),
      permanent_address TEXT,
      permanent_city VARCHAR(100),
      permanent_state_pin VARCHAR(100),
      co_applicant_name VARCHAR(150),
      co_relation VARCHAR(80),
      co_mobile VARCHAR(15),
      co_email VARCHAR(150),
      acc_holder_name VARCHAR(150),
      acc_bank_branch VARCHAR(150),
      drawn_bank_branch VARCHAR(150),
      acc_number VARCHAR(30),
      ifsc_code VARCHAR(15),
      application_status VARCHAR(50) DEFAULT 'Approved',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customer_nominees (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id UUID,
      nominee_name VARCHAR(150),
      relation VARCHAR(80),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plot_status_enum') THEN
        CREATE TYPE plot_status_enum AS ENUM ('Vacant', 'Booked', 'Registered', 'Hold', 'Blocked', 'InProcess', 'Available');
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS whatsapp_settings (
      id SERIAL PRIMARY KEY,
      is_enabled BOOLEAN DEFAULT FALSE
    );
    INSERT INTO whatsapp_settings (id, is_enabled) VALUES (1, FALSE) ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      invoice_number VARCHAR(100),
      booking_id INTEGER UNIQUE,
      user_id INTEGER,
      associate_id INTEGER,
      order_id VARCHAR(100),
      invoice_date TIMESTAMPTZ DEFAULT NOW(),
      subtotal NUMERIC(14,2) DEFAULT 0,
      grand_total NUMERIC(14,2) DEFAULT 0,
      paid_amount NUMERIC(14,2) DEFAULT 0,
      balance_amount NUMERIC(14,2) DEFAULT 0,
      payment_method VARCHAR(50),
      payment_status VARCHAR(50),
      order_status VARCHAR(50),
      invoice_data JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  log.push('ensurePlotAllocationSchema: OK');

  // 5. Sequence synchronizer (ensureCoreDatabaseSequences)
  await db.exec(`
    DO $$
    DECLARE
      r RECORD;
      max_val BIGINT;
    BEGIN
      FOR r IN (
        SELECT 
          c.table_name,
          c.column_name,
          pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) AS sequence_name
        FROM information_schema.columns c
        JOIN information_schema.tables t 
          ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public' 
          AND t.table_type = 'BASE TABLE'
          AND pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) IS NOT NULL
      ) LOOP
        BEGIN
          EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM %I', r.column_name, r.table_name) INTO max_val;
          IF max_val > 0 THEN
            EXECUTE format('SELECT setval(%L, %s, true)', r.sequence_name, max_val);
          END IF;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END LOOP;
    END $$;
  `);
  log.push('ensureCoreDatabaseSequences: OK');

  return log;
}
