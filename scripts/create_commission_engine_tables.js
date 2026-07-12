import sql from "../db.js";

try {
  await sql`
    CREATE TABLE IF NOT EXISTS commission_engine_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      commission_model TEXT NOT NULL DEFAULT 'Upline'
        CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution')),
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
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      version INTEGER NOT NULL DEFAULT 1,
      created_by_admin_id INTEGER,
      updated_by_admin_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS commission_engine_levels (
      id BIGSERIAL PRIMARY KEY,
      settings_id SMALLINT NOT NULL DEFAULT 1 REFERENCES commission_engine_settings(id) ON DELETE CASCADE,
      commission_model TEXT NOT NULL CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution')),
      level_no INTEGER NOT NULL CHECK (level_no BETWEEN 1 AND 50),
      percentage NUMERIC(8,4) NOT NULL CHECK (percentage BETWEEN 0 AND 100),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (settings_id, commission_model, level_no)
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS commission_engine_audit (
      audit_id BIGSERIAL PRIMARY KEY,
      settings_id SMALLINT NOT NULL,
      old_value JSONB NOT NULL,
      new_value JSONB NOT NULL,
      changed_by_admin_id INTEGER,
      reason TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION prevent_commission_engine_audit_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Commission engine audit history is immutable';
    END;
    $$ LANGUAGE plpgsql
  `);
  await sql.unsafe(`
    DROP TRIGGER IF EXISTS trg_commission_engine_audit_immutable ON commission_engine_audit;
    CREATE TRIGGER trg_commission_engine_audit_immutable
    BEFORE UPDATE OR DELETE ON commission_engine_audit
    FOR EACH ROW EXECUTE FUNCTION prevent_commission_engine_audit_mutation()
  `);

  await sql`
    CREATE TABLE IF NOT EXISTS commission_source_events (
      event_id BIGSERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE RESTRICT,
      source_type TEXT NOT NULL CHECK (source_type IN ('FullPayment','InitialPayment','EmiPayment','PartialPayment','Manual')),
      source_id TEXT NOT NULL,
      payment_type TEXT NOT NULL,
      received_amount NUMERIC(14,2) NOT NULL CHECK (received_amount > 0),
      plot_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      plot_area_gaj NUMERIC(14,2) NOT NULL DEFAULT 0,
      commission_model TEXT NOT NULL,
      engine_version INTEGER NOT NULL,
      generated_by_admin_id INTEGER,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (booking_id, source_type, source_id)
    )`;

  await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS commission_event_id BIGINT`;
  await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS commission_model TEXT`;
  await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS commission_level INTEGER`;
  await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS commission_percentage NUMERIC(8,4)`;
  await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS calculation_base NUMERIC(14,2)`;
  await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS source_type TEXT`;
  await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS source_reference TEXT`;
  await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS engine_version INTEGER`;
  await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS distribution_role TEXT`;
  await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS distribution_participants INTEGER`;
  await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS seller_user_id INTEGER`;
  await sql`ALTER TABLE commission_engine_settings ADD COLUMN IF NOT EXISTS seller_percentage NUMERIC(8,4) NOT NULL DEFAULT 50`;
  await sql`ALTER TABLE commission_engine_settings ADD COLUMN IF NOT EXISTS equal_distribution_percentage NUMERIC(8,4) NOT NULL DEFAULT 50`;
  await sql`ALTER TABLE commission_engine_settings ADD COLUMN IF NOT EXISTS equal_distribution_enabled BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE commission_engine_settings ADD COLUMN IF NOT EXISTS distribution_scope TEXT NOT NULL DEFAULT 'TopAssociateNetwork'`;
  await sql`ALTER TABLE commission_engine_settings ADD COLUMN IF NOT EXISTS payment_mode_rules JSONB NOT NULL DEFAULT '{"full_payment":"instant","emi":"installment_wise"}'::jsonb`;
  await sql.unsafe(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'commission_engine_settings_commission_model_check'
          AND conrelid = 'commission_engine_settings'::regclass
      ) THEN
        ALTER TABLE commission_engine_settings DROP CONSTRAINT commission_engine_settings_commission_model_check;
      END IF;
      ALTER TABLE commission_engine_settings
        ADD CONSTRAINT commission_engine_settings_commission_model_check
        CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution'));

      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'commission_engine_levels_commission_model_check'
          AND conrelid = 'commission_engine_levels'::regclass
      ) THEN
        ALTER TABLE commission_engine_levels DROP CONSTRAINT commission_engine_levels_commission_model_check;
      END IF;
      ALTER TABLE commission_engine_levels
        ADD CONSTRAINT commission_engine_levels_commission_model_check
        CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution'));
    END $$;
  `);

  await sql`
    INSERT INTO commission_engine_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING`;

  await sql`
    INSERT INTO commission_engine_levels (settings_id, commission_model, level_no, percentage)
    VALUES
      (1, 'LevelWise', 1, 10),
      (1, 'LevelWise', 2, 5),
      (1, 'LevelWise', 3, 3),
      (1, 'LevelWise', 4, 2),
      (1, 'LevelWise', 5, 1)
    ON CONFLICT (settings_id, commission_model, level_no) DO NOTHING`;

  await sql`CREATE INDEX IF NOT EXISTS idx_commission_levels_model_active ON commission_engine_levels(settings_id, commission_model, is_active, level_no)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_commission_engine_audit_changed ON commission_engine_audit(changed_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_commission_events_booking_date ON commission_source_events(booking_id, generated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_commission_transactions_event ON commission_transactions(commission_event_id, associate_user_id)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_transaction_event_level
    ON commission_transactions(commission_event_id, associate_user_id, commission_level)
    WHERE commission_event_id IS NOT NULL`;

  console.log("Commission engine schema is ready.");
} finally {
  await sql.end();
}
