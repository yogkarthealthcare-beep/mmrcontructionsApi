import sql from "../db.js";

const addConstraint = async (tableName, constraintName, constraintSql) => {
  const [existing] = await sql`
    SELECT 1
    FROM pg_constraint
    WHERE conname = ${constraintName}
      AND conrelid = ${tableName}::regclass`;
  if (!existing) {
    await sql.unsafe(`ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${constraintSql}`);
  }
};

async function main() {
  console.log("[MLM Migration] Creating MLM/referral tables...");

  await sql`
    CREATE TABLE IF NOT EXISTS associate_referral_links (
      id SERIAL PRIMARY KEY,
      associate_user_id INTEGER NOT NULL,
      invite_code VARCHAR(80) NOT NULL UNIQUE,
      referral_url TEXT,
      total_clicks INTEGER NOT NULL DEFAULT 0,
      total_registrations INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS referral_registrations (
      id SERIAL PRIMARY KEY,
      sponsor_user_id INTEGER,
      referred_user_id INTEGER UNIQUE,
      sponsor_invite_code VARCHAR(80),
      registration_source VARCHAR(80) DEFAULT 'ReferralLink',
      referral_level INTEGER NOT NULL DEFAULT 1,
      status VARCHAR(30) NOT NULL DEFAULT 'Pending',
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS mlm_tree_closure (
      id SERIAL PRIMARY KEY,
      ancestor_user_id INTEGER NOT NULL,
      descendant_user_id INTEGER NOT NULL,
      depth INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (ancestor_user_id, descendant_user_id)
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS associate_ranks (
      rank_id SERIAL PRIMARY KEY,
      rank_name VARCHAR(80) NOT NULL UNIQUE,
      min_direct_sales_gaj NUMERIC(12,2) NOT NULL DEFAULT 0,
      min_total_network_sales_gaj NUMERIC(12,2) NOT NULL DEFAULT 0,
      commission_multiplier NUMERIC(8,2) NOT NULL DEFAULT 1,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS associate_rank_history (
      id SERIAL PRIMARY KEY,
      associate_user_id INTEGER NOT NULL,
      old_rank_id INTEGER,
      new_rank_id INTEGER,
      changed_reason TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS commission_rules (
      rule_id SERIAL PRIMARY KEY,
      commission_type VARCHAR(30) NOT NULL,
      level_depth INTEGER NOT NULL DEFAULT 1,
      plot_area_unit VARCHAR(30) NOT NULL DEFAULT 'gaj',
      amount_per_100_gaj NUMERIC(14,2) NOT NULL DEFAULT 0,
      duration_months INTEGER NOT NULL DEFAULT 144,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS commission_monthly_schedule (
      schedule_id SERIAL PRIMARY KEY,
      commission_id INTEGER,
      associate_user_id INTEGER NOT NULL,
      booking_id INTEGER,
      month_no INTEGER NOT NULL,
      due_month DATE NOT NULL,
      amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'Pending',
      paid_at TIMESTAMPTZ,
      payment_reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (commission_id, month_no)
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS associate_status_history (
      id SERIAL PRIMARY KEY,
      associate_user_id INTEGER NOT NULL,
      old_status VARCHAR(40),
      new_status VARCHAR(40) NOT NULL,
      reason TEXT,
      duration_days INTEGER,
      changed_by_admin_id INTEGER,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS referral_clicks (
      id SERIAL PRIMARY KEY,
      associate_user_id INTEGER,
      invite_code VARCHAR(80),
      ip_address TEXT,
      user_agent TEXT,
      clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS associate_payout_requests (
      payout_id SERIAL PRIMARY KEY,
      associate_user_id INTEGER NOT NULL,
      requested_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      approved_amount NUMERIC(14,2),
      status VARCHAR(30) NOT NULL DEFAULT 'Requested',
      payment_reference TEXT,
      admin_note TEXT,
      reviewed_by_admin_id INTEGER,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ
    )`;

  console.log("[MLM Migration] Adding helper columns if missing...");
  await sql`ALTER TABLE associate_sales_tracker ADD COLUMN IF NOT EXISTS current_rank_id INTEGER`;
  await sql`ALTER TABLE associate_sales_tracker ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`;

  console.log("[MLM Migration] Adding relations...");
  await addConstraint("associate_referral_links", "fk_associate_referral_links_user", "FOREIGN KEY (associate_user_id) REFERENCES users(user_id) ON DELETE CASCADE");
  await addConstraint("referral_registrations", "fk_referral_registrations_sponsor", "FOREIGN KEY (sponsor_user_id) REFERENCES users(user_id) ON DELETE SET NULL");
  await addConstraint("referral_registrations", "fk_referral_registrations_referred", "FOREIGN KEY (referred_user_id) REFERENCES users(user_id) ON DELETE CASCADE");
  await addConstraint("mlm_tree_closure", "fk_mlm_tree_closure_ancestor", "FOREIGN KEY (ancestor_user_id) REFERENCES users(user_id) ON DELETE CASCADE");
  await addConstraint("mlm_tree_closure", "fk_mlm_tree_closure_descendant", "FOREIGN KEY (descendant_user_id) REFERENCES users(user_id) ON DELETE CASCADE");
  await addConstraint("associate_rank_history", "fk_associate_rank_history_user", "FOREIGN KEY (associate_user_id) REFERENCES users(user_id) ON DELETE CASCADE");
  await addConstraint("associate_rank_history", "fk_associate_rank_history_old_rank", "FOREIGN KEY (old_rank_id) REFERENCES associate_ranks(rank_id) ON DELETE SET NULL");
  await addConstraint("associate_rank_history", "fk_associate_rank_history_new_rank", "FOREIGN KEY (new_rank_id) REFERENCES associate_ranks(rank_id) ON DELETE SET NULL");
  await addConstraint("commission_monthly_schedule", "fk_commission_monthly_schedule_commission", "FOREIGN KEY (commission_id) REFERENCES commission_transactions(commission_id) ON DELETE CASCADE");
  await addConstraint("commission_monthly_schedule", "fk_commission_monthly_schedule_user", "FOREIGN KEY (associate_user_id) REFERENCES users(user_id) ON DELETE CASCADE");
  await addConstraint("commission_monthly_schedule", "fk_commission_monthly_schedule_booking", "FOREIGN KEY (booking_id) REFERENCES bookings(booking_id) ON DELETE CASCADE");
  await addConstraint("associate_status_history", "fk_associate_status_history_user", "FOREIGN KEY (associate_user_id) REFERENCES users(user_id) ON DELETE CASCADE");
  await addConstraint("associate_status_history", "fk_associate_status_history_admin", "FOREIGN KEY (changed_by_admin_id) REFERENCES admin_users(admin_id) ON DELETE SET NULL");
  await addConstraint("referral_clicks", "fk_referral_clicks_user", "FOREIGN KEY (associate_user_id) REFERENCES users(user_id) ON DELETE CASCADE");
  await addConstraint("associate_payout_requests", "fk_associate_payout_requests_user", "FOREIGN KEY (associate_user_id) REFERENCES users(user_id) ON DELETE CASCADE");
  await addConstraint("associate_payout_requests", "fk_associate_payout_requests_admin", "FOREIGN KEY (reviewed_by_admin_id) REFERENCES admin_users(admin_id) ON DELETE SET NULL");
  await addConstraint("associate_sales_tracker", "fk_associate_sales_tracker_rank", "FOREIGN KEY (current_rank_id) REFERENCES associate_ranks(rank_id) ON DELETE SET NULL");

  console.log("[MLM Migration] Adding checks and indexes...");
  await addConstraint("referral_registrations", "chk_referral_registrations_status", "CHECK (status IN ('Pending','Approved','Rejected'))");
  await addConstraint("commission_monthly_schedule", "chk_commission_monthly_schedule_status", "CHECK (status IN ('Pending','Approved','Paid','Hold','Cancelled'))");
  await addConstraint("associate_payout_requests", "chk_associate_payout_requests_status", "CHECK (status IN ('Requested','Approved','Rejected','Paid'))");
  await addConstraint("commission_rules", "chk_commission_rules_type", "CHECK (commission_type IN ('Direct','Upline','Bonus','Monthly'))");

  await sql`
    DELETE FROM commission_rules duplicate
    USING commission_rules keeper
    WHERE duplicate.rule_id > keeper.rule_id
      AND duplicate.is_active = TRUE
      AND keeper.is_active = TRUE
      AND duplicate.commission_type = keeper.commission_type
      AND duplicate.level_depth = keeper.level_depth
      AND duplicate.plot_area_unit = keeper.plot_area_unit`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_rules_active_level
    ON commission_rules (commission_type, level_depth, plot_area_unit)
    WHERE is_active = TRUE`;
  await sql`CREATE INDEX IF NOT EXISTS idx_associate_referral_links_user ON associate_referral_links(associate_user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_referral_reg_sponsor ON referral_registrations(sponsor_user_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_referral_reg_referred ON referral_registrations(referred_user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_mlm_tree_ancestor ON mlm_tree_closure(ancestor_user_id, depth)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_mlm_tree_descendant ON mlm_tree_closure(descendant_user_id, depth)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_commission_rules_active ON commission_rules(is_active, commission_type, level_depth)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_commission_schedule_assoc ON commission_monthly_schedule(associate_user_id, due_month)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_commission_schedule_booking ON commission_monthly_schedule(booking_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_status_history_assoc ON associate_status_history(associate_user_id, changed_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_referral_clicks_assoc ON referral_clicks(associate_user_id, clicked_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_payout_assoc ON associate_payout_requests(associate_user_id, requested_at DESC)`;

  console.log("[MLM Migration] Seeding default ranks and rules...");
  await sql`
    INSERT INTO associate_ranks (rank_name, min_direct_sales_gaj, min_total_network_sales_gaj, commission_multiplier)
    VALUES
      ('Associate', 0, 0, 1),
      ('Senior Associate', 500, 1500, 1.10),
      ('Leader', 1500, 5000, 1.25)
    ON CONFLICT (rank_name) DO NOTHING`;

  await sql`
    INSERT INTO commission_rules (commission_type, level_depth, plot_area_unit, amount_per_100_gaj, duration_months)
    SELECT * FROM (VALUES
      ('Direct', 1, 'gaj', 600::numeric, 144),
      ('Upline', 2, 'gaj', 150::numeric, 144),
      ('Upline', 3, 'gaj', 75::numeric, 144)
    ) AS seed(commission_type, level_depth, plot_area_unit, amount_per_100_gaj, duration_months)
    WHERE NOT EXISTS (
      SELECT 1 FROM commission_rules r
      WHERE r.commission_type = seed.commission_type
        AND r.level_depth = seed.level_depth
    )`;

  const tables = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'associate_referral_links',
        'referral_registrations',
        'mlm_tree_closure',
        'associate_ranks',
        'associate_rank_history',
        'commission_rules',
        'commission_monthly_schedule',
        'associate_status_history',
        'referral_clicks',
        'associate_payout_requests'
      )
    ORDER BY table_name`;

  console.log("[MLM Migration] Created/verified tables:");
  for (const row of tables) console.log(`- ${row.table_name}`);
}

main()
  .catch((error) => {
    console.error("[MLM Migration] Failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
