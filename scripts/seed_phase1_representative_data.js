/**
 * MMR Construction & Developers Pvt. Ltd.
 * Representative Seed Data for Phase 1 Migration & Verification
 * Creates realistic representative data:
 * - 1 Admin / Default Sponsor (Suraj Kumar Verma)
 * - 3 Active Associates
 * - 5 Active Team Members
 * - 50 Realistic Customers (mix of referral codes, TM referrals, default sponsor fallback, direct)
 * - 30 Bookings (Confirmed, Submitted, PaymentPending, Allocated, Waitlisted, Cancelled, Assisted, Self-Purchases)
 */

export async function createBaseSchema(db) {
  // 1. users table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id SERIAL PRIMARY KEY,
      member_id VARCHAR(50) UNIQUE,
      user_type VARCHAR(50) NOT NULL DEFAULT 'Customer',
      full_name VARCHAR(150) NOT NULL,
      email VARCHAR(150) UNIQUE,
      mobile_no VARCHAR(20) UNIQUE,
      password_hash VARCHAR(255),
      account_status VARCHAR(50) NOT NULL DEFAULT 'Active',
      is_active BOOLEAN DEFAULT TRUE,
      is_verified BOOLEAN DEFAULT TRUE,
      email_verified BOOLEAN DEFAULT TRUE,
      email_verified_at TIMESTAMPTZ,
      is_otp_verified BOOLEAN DEFAULT TRUE,
      sponsor_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
      invitation_code VARCHAR(50),
      pan_number VARCHAR(20),
      aadhar_number VARCHAR(20),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      registered_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 2. sites table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      site_id SERIAL PRIMARY KEY,
      site_name VARCHAR(150) NOT NULL,
      location VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 3. plots table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS plots (
      plot_id SERIAL PRIMARY KEY,
      site_id INT REFERENCES sites(site_id),
      plot_number VARCHAR(50) NOT NULL,
      plot_area NUMERIC(10,2) DEFAULT 100,
      base_price NUMERIC(14,2) DEFAULT 1000000,
      plot_status VARCHAR(50) NOT NULL DEFAULT 'Vacant',
      sold_price NUMERIC(14,2),
      sold_at TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 4. team_members table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      team_member_uid VARCHAR(50) UNIQUE NOT NULL,
      associate_id INT NOT NULL REFERENCES users(user_id),
      associate_name VARCHAR(150),
      user_id INT REFERENCES users(user_id),
      slot_number INT NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      mobile_no VARCHAR(20),
      email_id VARCHAR(150),
      status VARCHAR(50) NOT NULL DEFAULT 'approved',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 5. referral_registrations table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS referral_registrations (
      id SERIAL PRIMARY KEY,
      sponsor_user_id INT REFERENCES users(user_id),
      referred_user_id INT UNIQUE REFERENCES users(user_id),
      sponsor_invite_code VARCHAR(50),
      registration_source VARCHAR(80),
      source VARCHAR(80),
      status VARCHAR(50) NOT NULL DEFAULT 'Approved',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      approved_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 6. bookings table (pre-migration columns)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      booking_id SERIAL PRIMARY KEY,
      booking_serial VARCHAR(50) UNIQUE NOT NULL,
      user_id INT NOT NULL REFERENCES users(user_id),
      plot_id INT REFERENCES plots(plot_id),
      site_id INT REFERENCES sites(site_id),
      payment_type VARCHAR(50) NOT NULL DEFAULT 'FullPayment',
      advance_amount NUMERIC(14,2) DEFAULT 50000,
      booking_status VARCHAR(50) NOT NULL DEFAULT 'Submitted',
      workflow_status VARCHAR(100),
      payment_method VARCHAR(50) DEFAULT 'Online',
      notes TEXT,
      queue_position INT DEFAULT 1,
      refund_due BOOLEAN DEFAULT FALSE,
      booking_date DATE DEFAULT CURRENT_DATE,
      required_booking_amount NUMERIC(14,2),
      remaining_balance NUMERIC(14,2),
      confirmed_at TIMESTAMPTZ,
      confirmed_by_admin_id INT REFERENCES users(user_id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 7. Auxiliary tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS associate_sales_tracker (
      id SERIAL PRIMARY KEY,
      associate_user_id INT UNIQUE REFERENCES users(user_id),
      total_sales_count INT DEFAULT 0,
      total_sales_volume NUMERIC(14,2) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mlm_network (
      id SERIAL PRIMARY KEY,
      associate_user_id INT UNIQUE REFERENCES users(user_id),
      sponsor_user_id INT REFERENCES users(user_id),
      level INT DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_kyc_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      status VARCHAR(30) NOT NULL DEFAULT 'Not Submitted'
        CHECK (status IN ('Not Submitted','Submitted','Under Review','Approved','Rejected')),
      admin_remarks TEXT,
      submitted_at TIMESTAMPTZ,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS plot_booking_locks (
      lock_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      booking_id INTEGER REFERENCES bookings(booking_id) ON DELETE CASCADE,
      lock_token UUID NOT NULL DEFAULT gen_random_uuid(),
      status VARCHAR(20) NOT NULL DEFAULT 'Active',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS investors (
      id SERIAL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      profile_image_url TEXT NOT NULL DEFAULT '',
      profile_image_public_id TEXT,
      designation VARCHAR(160),
      short_description TEXT,
      user_id INTEGER,
      investment_amount NUMERIC(15, 2) DEFAULT 0,
      display_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS emi_schedules (
      id SERIAL PRIMARY KEY,
      emi_id SERIAL,
      booking_id INT REFERENCES bookings(booking_id) ON DELETE CASCADE,
      user_id INT REFERENCES users(user_id),
      installment_no INT NOT NULL,
      due_date DATE NOT NULL,
      emi_amount NUMERIC(14,2) NOT NULL,
      paid_amount NUMERIC(14,2) DEFAULT 0,
      paid_date TIMESTAMPTZ,
      late_fee_amount NUMERIC(14,2) DEFAULT 0,
      emi_status VARCHAR(30) DEFAULT 'Pending',
      status VARCHAR(30) DEFAULT 'Pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      audit_id SERIAL PRIMARY KEY,
      actor_type VARCHAR(50),
      actor_id INT,
      actor_name VARCHAR(255),
      module VARCHAR(100),
      action VARCHAR(100),
      target_table VARCHAR(100),
      target_record_id VARCHAR(100),
      old_value JSONB,
      new_value JSONB,
      ip_address VARCHAR(45),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payment_gateway_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      gateway_name VARCHAR(50) UNIQUE NOT NULL,
      display_name VARCHAR(100),
      is_enabled BOOLEAN DEFAULT false,
      is_default BOOLEAN DEFAULT false,
      allow_user_selection BOOLEAN DEFAULT true,
      fallback_enabled BOOLEAN DEFAULT false,
      priority INTEGER DEFAULT 1,
      status VARCHAR(50) DEFAULT 'inactive',
      environment_mode VARCHAR(50),
      public_key TEXT,
      encrypted_secret_key TEXT,
      encrypted_client_secret TEXT,
      encrypted_webhook_secret TEXT,
      callback_url TEXT,
      webhook_url TEXT,
      success_url TEXT,
      failure_url TEXT,
      cancel_url TEXT,
      min_customer_fund_amount NUMERIC(12,2) DEFAULT 100.00,
      min_associate_fund_amount NUMERIC(12,2) DEFAULT 100.00,
      extra_config JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS booking_payment_proofs (
      id SERIAL PRIMARY KEY,
      booking_id INT,
      file_path TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS booking_appointments (
      appointment_id SERIAL PRIMARY KEY,
      booking_id INT,
      user_id INT,
      appointment_date DATE,
      start_time TIME,
      end_time TIME,
      status VARCHAR(50) DEFAULT 'Scheduled',
      payment_mode VARCHAR(50) DEFAULT 'Office Visit',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

export async function seedRepresentativeData(db) {
  // Clear any existing test data cleanly in foreign key dependency order
  await db.exec(`
    DELETE FROM payment_gateway_configs;
    DELETE FROM emi_schedules;
    DELETE FROM plot_booking_locks;
    DELETE FROM bookings;
    DELETE FROM user_kyc_profiles;
    DELETE FROM audit_log;
    DELETE FROM referral_registrations;
    DELETE FROM team_members;
    DELETE FROM plots;
    DELETE FROM sites;
    DELETE FROM associate_sales_tracker;
    DELETE FROM mlm_network;
    DELETE FROM users;
  `);

  await db.exec(`
    INSERT INTO payment_gateway_configs (
      gateway_name, display_name, is_enabled, is_default, allow_user_selection, status, environment_mode
    ) VALUES
    ('razorpay', 'Razorpay', true, true, true, 'active', 'test'),
    ('cashfree', 'Cashfree', true, false, true, 'active', 'test')
    ON CONFLICT (gateway_name) DO NOTHING;
  `);

  // 1. Insert Sites
  await db.exec(`
    INSERT INTO sites (site_id, site_name, location) VALUES
    (1, 'Green Valley City', 'Sector 12, Lucknow'),
    (2, 'Sunrise Enclave', 'Kisan Path, Lucknow');
  `);

  // 2. Insert Plots (Plots 1 to 30)
  for (let i = 1; i <= 30; i++) {
    const siteId = i <= 15 ? 1 : 2;
    const plotNo = `P-${String(i).padStart(3, '0')}`;
    const basePrice = 1200000 + (i * 25000);
    await db.exec(`
      INSERT INTO plots (plot_id, site_id, plot_number, plot_area, base_price, plot_status)
      VALUES (${i}, ${siteId}, '${plotNo}', 120, ${basePrice}, 'Vacant');
    `);
  }

  // 3. Insert Admin / Default Sponsor (User 1)
  await db.exec(`
    INSERT INTO users (user_id, member_id, user_type, full_name, email, mobile_no, account_status, invitation_code)
    VALUES (1, 'MMR00001', 'Admin', 'Suraj Kumar Verma', 'mmrconstructions@hotmail.com', '7071951011', 'Active', 'MMR00001');
  `);

  // 4. Insert 3 Associates (User 101, 102, 103)
  const associates = [
    { id: 101, memberId: 'MMR-ASC-00101', name: 'Rajesh Sharma', email: 'rajesh.sharma@example.com', mobile: '9876543201', code: 'MMRASC101' },
    { id: 102, memberId: 'MMR-ASC-00102', name: 'Priya Singh', email: 'priya.singh@example.com', mobile: '9876543202', code: 'MMRASC102' },
    { id: 103, memberId: 'MMR-ASC-00103', name: 'Amit Patel', email: 'amit.patel@example.com', mobile: '9876543203', code: 'MMRASC103' }
  ];

  for (const a of associates) {
    await db.exec(`
      INSERT INTO users (user_id, member_id, user_type, full_name, email, mobile_no, account_status, sponsor_user_id, invitation_code)
      VALUES (${a.id}, '${a.memberId}', 'Associate', '${a.name}', '${a.email}', '${a.mobile}', 'Active', 1, '${a.code}');
      
      INSERT INTO associate_sales_tracker (associate_user_id) VALUES (${a.id});
      INSERT INTO mlm_network (associate_user_id, sponsor_user_id, level) VALUES (${a.id}, 1, 1);
    `);
  }

  // 5. Insert 5 Team Members (User 201 to 205)
  const teamMembers = [
    { id: 201, assocId: 101, slot: 1, uid: 'MMR-TM-00201', name: 'Vikram Rao', email: 'vikram.rao@example.com', mobile: '9876543291' },
    { id: 202, assocId: 101, slot: 2, uid: 'MMR-TM-00202', name: 'Sunita Devi', email: 'sunita.devi@example.com', mobile: '9876543292' },
    { id: 203, assocId: 102, slot: 1, uid: 'MMR-TM-00203', name: 'Rahul Gupta', email: 'rahul.gupta@example.com', mobile: '9876543293' },
    { id: 204, assocId: 102, slot: 2, uid: 'MMR-TM-00204', name: 'Pooja Verma', email: 'pooja.verma@example.com', mobile: '9876543294' },
    { id: 205, assocId: 103, slot: 1, uid: 'MMR-TM-00205', name: 'Deepak Joshi', email: 'deepak.joshi@example.com', mobile: '9876543295' }
  ];

  for (const tm of teamMembers) {
    await db.exec(`
      INSERT INTO users (user_id, member_id, user_type, full_name, email, mobile_no, account_status, sponsor_user_id)
      VALUES (${tm.id}, '${tm.uid}', 'Team Member', '${tm.name}', '${tm.email}', '${tm.mobile}', 'Active', ${tm.assocId});

      INSERT INTO team_members (team_member_uid, associate_id, associate_name, user_id, slot_number, full_name, mobile_no, email_id, status)
      VALUES ('${tm.uid}', ${tm.assocId}, (SELECT full_name FROM users WHERE user_id = ${tm.assocId}), ${tm.id}, ${tm.slot}, '${tm.name}', '${tm.mobile}', '${tm.email}', 'approved');
    `);
  }

  // 6. Insert 50 Customers (User 301 to 350) with diverse referral configurations
  // - 301..310: Referred by Assoc 101 via referral_registrations with code 'MMRASC101'
  // - 311..320: Referred by TM 201 (users.sponsor_user_id = 201, no referral_registration)
  // - 321..330: Referred by TM 203 (users.sponsor_user_id = 203, with referral_registration)
  // - 331..340: Organic signup defaulted to User 1 (users.sponsor_user_id = 1, NO referral_registration) -> Company Direct
  // - 341..345: Admin direct customer (sponsor_user_id = NULL) -> Company Direct
  // - 346..350: Referred by Assoc 102 via referral_registrations with code 'MMRASC102'
  for (let c = 301; c <= 350; c++) {
    const memberId = `MMR-CUS-${String(c).padStart(5, '0')}`;
    const name = `Customer ${c - 300}`;
    const email = `customer${c}@example.com`;
    const mobile = `980000${String(c).padStart(4, '0')}`;

    let sponsorId = null;
    if (c >= 301 && c <= 310) sponsorId = 101; // Path 3: Associate Rajesh Sharma
    else if (c >= 311 && c <= 320) sponsorId = 201; // TM Vikram Rao
    else if (c >= 321 && c <= 330) sponsorId = 203; // TM Rahul Gupta
    else if (c >= 331 && c <= 340) sponsorId = 1; // Default sponsor bug (Suraj / User 1)
    else if (c >= 341 && c <= 345) sponsorId = null; // Admin direct
    else if (c >= 346 && c <= 348) sponsorId = 301; // Ineligible sponsor (Customer 301 cannot refer!)
    else if (c >= 349 && c <= 350) sponsorId = 102; // Associate Priya Singh

    await db.exec(`
      INSERT INTO users (user_id, member_id, user_type, full_name, email, mobile_no, account_status, sponsor_user_id)
      VALUES (${c}, '${memberId}', 'Customer', '${name}', '${email}', '${mobile}', 'Active', ${sponsorId ? sponsorId : 'NULL'});
    `);

    // Insert referral_registrations rows:
    // (a) Genuine Path-3 / explicit referral rows:
    if (c >= 301 && c <= 310) {
      await db.exec(`
        INSERT INTO referral_registrations (sponsor_user_id, referred_user_id, sponsor_invite_code, status)
        VALUES (101, ${c}, 'MMRASC101', 'Approved');
      `);
    } else if (c >= 321 && c <= 330) {
      await db.exec(`
        INSERT INTO referral_registrations (sponsor_user_id, referred_user_id, sponsor_invite_code, status)
        VALUES (203, ${c}, 'MMRTM203', 'Approved');
      `);
    } else if (c >= 349 && c <= 350) {
      await db.exec(`
        INSERT INTO referral_registrations (sponsor_user_id, referred_user_id, sponsor_invite_code, status)
        VALUES (102, ${c}, 'MMRASC102', 'Approved');
      `);
    }
    // (b) CRITICAL REALISTIC CASE (Task 1): Sync-generated rows by syncMlmTreeAndReferrals()
    // For default-sponsor customers (331..340), sync generated rr rows with sponsor_invite_code = NULL!
    else if (c >= 331 && c <= 340) {
      await db.exec(`
        INSERT INTO referral_registrations (sponsor_user_id, referred_user_id, sponsor_invite_code, status)
        VALUES (1, ${c}, NULL, 'Approved');
      `);
    }
  }

  // 7. Insert 30 Bookings with realistic status distribution & waitlist scenarios
  // Booking 1..8: Confirmed Sales
  // Booking 9..13: Submitted
  // Booking 14..17: PaymentPending
  // Booking 18..20: Allocated
  // Booking 21..25: Waitlisted (Plot 10 has Booking 1 Confirmed + Booking 21, 22 Waitlisted!)
  // Booking 26..28: Cancelled
  // Booking 29: Assisted Booking by Associate with notes
  // Booking 30: Self-purchase by Associate 101

  const bookingDefs = [
    // Confirmed Sales
    { id: 1, serial: 'MMR-2026-00001', buyer: 301, plot: 1, type: 'FullPayment', status: 'Confirmed', notes: 'Full payment cleared' },
    { id: 2, serial: 'MMR-2026-00002', buyer: 302, plot: 2, type: 'EMI', status: 'Confirmed', notes: 'EMI Plan 60 months' },
    { id: 3, serial: 'MMR-2026-00003', buyer: 311, plot: 3, type: 'FullPayment', status: 'Confirmed', notes: 'TM Vikram referral' },
    { id: 4, serial: 'MMR-2026-00004', buyer: 312, plot: 4, type: 'EMI', status: 'Confirmed', notes: 'Down payment paid' },
    { id: 5, serial: 'MMR-2026-00005', buyer: 321, plot: 5, type: 'FullPayment', status: 'Confirmed', notes: 'TM Rahul referral' },
    { id: 6, serial: 'MMR-2026-00006', buyer: 331, plot: 6, type: 'FullPayment', status: 'Confirmed', notes: 'Company direct client' },
    { id: 7, serial: 'MMR-2026-00007', buyer: 341, plot: 7, type: 'FullPayment', status: 'Confirmed', notes: 'Admin walk-in customer' },
    { id: 8, serial: 'MMR-2026-00008', buyer: 346, plot: 8, type: 'EMI', status: 'Confirmed', notes: 'Priya Singh direct' },

    // Submitted (Pending Admin review)
    { id: 9, serial: 'MMR-2026-00009', buyer: 303, plot: 9, type: 'FullPayment', status: 'Submitted', notes: 'Online application' },
    { id: 10, serial: 'MMR-2026-00010', buyer: 313, plot: 11, type: 'EMI', status: 'Submitted', notes: 'Awaiting doc check' },
    { id: 11, serial: 'MMR-2026-00011', buyer: 322, plot: 13, type: 'FullPayment', status: 'Submitted', notes: 'Cheque submitted' },
    { id: 12, serial: 'MMR-2026-00012', buyer: 332, plot: 14, type: 'FullPayment', status: 'Submitted', notes: 'Direct website booking' },
    { id: 13, serial: 'MMR-2026-00013', buyer: 347, plot: 15, type: 'EMI', status: 'Submitted', notes: 'Application under review' },

    // PaymentPending
    { id: 14, serial: 'MMR-2026-00014', buyer: 304, plot: 16, type: 'FullPayment', status: 'PaymentPending', notes: 'Gateway pending' },
    { id: 15, serial: 'MMR-2026-00015', buyer: 314, plot: 17, type: 'EMI', status: 'PaymentPending', notes: 'Cheque clearing' },
    { id: 16, serial: 'MMR-2026-00016', buyer: 323, plot: 18, type: 'FullPayment', status: 'PaymentPending', notes: 'NEFT verification' },
    { id: 17, serial: 'MMR-2026-00017', buyer: 333, plot: 19, type: 'FullPayment', status: 'PaymentPending', notes: 'RTGS verification' },

    // Allocated
    { id: 18, serial: 'MMR-2026-00018', buyer: 305, plot: 20, type: 'FullPayment', status: 'Allocated', notes: 'Plot reserved, allotment issued' },
    { id: 19, serial: 'MMR-2026-00019', buyer: 315, plot: 21, type: 'EMI', status: 'Allocated', notes: 'Allotment letter pending sign' },
    { id: 20, serial: 'MMR-2026-00020', buyer: 348, plot: 22, type: 'FullPayment', status: 'Allocated', notes: 'Final step to confirmation' },

    // Waitlisted Bookings (TEST WAITLIST INTEGRITY ON SAME PLOT AS CONFIRMED/ALLOCATED)
    // Plot 1 has Booking 1 (Confirmed). Booking 21 & 22 are Waitlisted on Plot 1!
    { id: 21, serial: 'MMR-2026-00021', buyer: 306, plot: 1, type: 'FullPayment', status: 'Waitlisted', queue: 1, notes: 'Waitlist candidate 1 on Plot 1' },
    { id: 22, serial: 'MMR-2026-00022', buyer: 307, plot: 1, type: 'FullPayment', status: 'Waitlisted', queue: 2, notes: 'Waitlist candidate 2 on Plot 1' },
    // Plot 3 has Booking 3 (Confirmed). Booking 23 is Waitlisted on Plot 3!
    { id: 23, serial: 'MMR-2026-00023', buyer: 316, plot: 3, type: 'EMI', status: 'Waitlisted', queue: 1, notes: 'Waitlist on Plot 3' },
    // Plot 20 has Booking 18 (Allocated). Booking 24 is Waitlisted on Plot 20!
    { id: 24, serial: 'MMR-2026-00024', buyer: 324, plot: 20, type: 'FullPayment', status: 'Waitlisted', queue: 1, notes: 'Waitlist candidate on Plot 20' },
    { id: 25, serial: 'MMR-2026-00025', buyer: 334, plot: 25, type: 'FullPayment', status: 'Waitlisted', queue: 1, notes: 'Single applicant waitlisted' },

    // Cancelled Bookings
    { id: 26, serial: 'MMR-2026-00026', buyer: 308, plot: 26, type: 'FullPayment', status: 'Cancelled', notes: 'Cancelled by customer' },
    { id: 27, serial: 'MMR-2026-00027', buyer: 317, plot: 27, type: 'EMI', status: 'Cancelled', notes: 'Cancelled due to non-payment' },
    { id: 28, serial: 'MMR-2026-00028', buyer: 335, plot: 28, type: 'FullPayment', status: 'Cancelled', notes: 'Cheque bounced' },

    // Assisted booking by Associate (Note with Associate name & ID)
    { id: 29, serial: 'MMR-2026-00029', buyer: 309, plot: 29, type: 'FullPayment', status: 'Confirmed', notes: 'Assisted booking by Associate Rajesh Sharma (MMR-ASC-00101)' },

    // Self Purchase by Associate 101
    { id: 30, serial: 'MMR-2026-00030', buyer: 101, plot: 30, type: 'FullPayment', status: 'Confirmed', notes: 'Associate self investment plot' }
  ];

  for (const b of bookingDefs) {
    const queue = b.queue || 1;
    await db.exec(`
      INSERT INTO bookings (
        booking_id, booking_serial, user_id, plot_id, site_id, payment_type,
        advance_amount, booking_status, notes, queue_position
      ) VALUES (
        ${b.id}, '${b.serial}', ${b.buyer}, ${b.plot}, ${b.plot <= 15 ? 1 : 2}, '${b.type}',
        100000, '${b.status}', '${b.notes.replace(/'/g, "''")}', ${queue}
      );
    `);

    // Update plot status accordingly
    let plotStatus = 'Vacant';
    if (b.status === 'Confirmed') plotStatus = 'Booked';
    else if (['Submitted', 'PaymentPending', 'Allocated'].includes(b.status)) plotStatus = 'InProcess';

    await db.exec(`
      UPDATE plots SET plot_status = '${plotStatus}', updated_at = NOW() WHERE plot_id = ${b.plot};
    `);
  }

  // Sync PostgreSQL sequences to max IDs to prevent pkey duplicate key errors on subsequent inserts
  await db.exec(`
    SELECT setval('bookings_booking_id_seq', (SELECT COALESCE(MAX(booking_id), 1) FROM bookings));
    SELECT setval('users_user_id_seq', (SELECT COALESCE(MAX(user_id), 1) FROM users));
    SELECT setval('plots_plot_id_seq', (SELECT COALESCE(MAX(plot_id), 1) FROM plots));
  `);
}
