import sql from "../db.js";

let schemaInitialized = false;

/**
 * Initializes upi_qr_configs table and columns idempotently.
 */
export async function initUpiQrSchema() {
  if (schemaInitialized) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS upi_qr_configs (
        id SERIAL PRIMARY KEY,
        qr_code_key VARCHAR(50) UNIQUE NOT NULL,
        label VARCHAR(100) NOT NULL,
        upi_id VARCHAR(100) NOT NULL,
        qr_image_url TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        is_primary BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;

    // Backward-compatible column additions for payment verification
    await sql`ALTER TABLE booking_payment_proofs ADD COLUMN IF NOT EXISTS payer_name VARCHAR(255)`;
    await sql`ALTER TABLE booking_payment_proofs ADD COLUMN IF NOT EXISTS utr_number VARCHAR(100)`;
    await sql`ALTER TABLE booking_payment_proofs ADD COLUMN IF NOT EXISTS qr_code_key VARCHAR(50)`;
    await sql`ALTER TABLE payment_ledger ADD COLUMN IF NOT EXISTS payer_name VARCHAR(255)`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payer_name VARCHAR(255)`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS utr_number VARCHAR(100)`;

    // Create company_bank_settings table for dynamic bank details and booking payment method checkboxes
    await sql`
      CREATE TABLE IF NOT EXISTS company_bank_settings (
        id SERIAL PRIMARY KEY,
        setting_key VARCHAR(50) UNIQUE NOT NULL DEFAULT 'default_bank',
        account_name VARCHAR(255) NOT NULL DEFAULT 'MMR CONSTRUCTIONS PRIVATE LIMITED',
        bank_name VARCHAR(150) NOT NULL DEFAULT 'HDFC Bank Ltd.',
        account_number VARCHAR(100) NOT NULL DEFAULT '50200088921832',
        ifsc_code VARCHAR(50) NOT NULL DEFAULT 'HDFC0001234',
        branch_name VARCHAR(150) NOT NULL DEFAULT 'Civil Lines, Kanpur',
        enable_primary_upi BOOLEAN DEFAULT TRUE,
        enable_secondary_upi BOOLEAN DEFAULT TRUE,
        enable_bank_transfer BOOLEAN DEFAULT TRUE,
        enable_payment_gateway BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;

    // Seed default bank settings if empty
    const existingBank = await sql`SELECT COUNT(*)::int as count FROM company_bank_settings`;
    if ((existingBank[0]?.count || 0) === 0) {
      await sql`
        INSERT INTO company_bank_settings (
          setting_key, account_name, bank_name, account_number, ifsc_code, branch_name,
          enable_primary_upi, enable_secondary_upi, enable_bank_transfer, enable_payment_gateway
        ) VALUES (
          'default_bank', 'MMR CONSTRUCTIONS PRIVATE LIMITED', 'HDFC Bank Ltd.', '50200088921832', 'HDFC0001234', 'Civil Lines, Kanpur',
          true, true, true, true
        ) ON CONFLICT (setting_key) DO NOTHING
      `;
    }

    // Seed default QR1 & QR2 if table is empty
    const existing = await sql`SELECT COUNT(*)::int as count FROM upi_qr_configs`;
    if ((existing[0]?.count || 0) === 0) {
      await sql`
        INSERT INTO upi_qr_configs (qr_code_key, label, upi_id, qr_image_url, is_active, is_primary)
        VALUES 
          ('qr1', 'Primary UPI QR (HDFC Bank)', 'mmrconstructions@hdfcbank', '/assets/images/qr/mmr_qr1.png', true, true),
          ('qr2', 'Secondary UPI QR (ICICI Bank)', 'mmrconstructions@icici', '/assets/images/qr/mmr_qr2.png', true, false)
        ON CONFLICT (qr_code_key) DO NOTHING
      `;
    }

    schemaInitialized = true;
    console.log("[UPI QR & Bank Settings] Database schema and initial records verified.");
  } catch (err) {
    console.error("[UPI QR & Bank Settings] Schema initialization error:", err.message);
  }
}

/**
 * Fetches all UPI QR configurations for Admin Management.
 */
export async function getAllQrConfigs() {
  await initUpiQrSchema();
  const rows = await sql`
    SELECT id, qr_code_key, label, upi_id, qr_image_url, is_active, is_primary, created_at, updated_at
    FROM upi_qr_configs
    ORDER BY id ASC
  `;
  return rows;
}

/**
 * Fetches only active UPI QR configurations for Customer/Booking UI.
 * Does not expose any sensitive server configurations.
 */
export async function getActiveQrConfigs() {
  await initUpiQrSchema();
  const rows = await sql`
    SELECT qr_code_key, label, upi_id, qr_image_url, is_primary
    FROM upi_qr_configs
    WHERE is_active = TRUE
    ORDER BY is_primary DESC, id ASC
  `;
  return rows;
}

/**
 * Updates or creates a UPI QR configuration by qr_code_key.
 */
export async function saveQrConfig({ qr_code_key, label, upi_id, qr_image_url, is_active, is_primary }) {
  await initUpiQrSchema();
  const key = String(qr_code_key || 'qr1').toLowerCase();

  return await sql.begin(async (tx) => {
    if (is_primary) {
      // Unset primary on other QRs
      await tx`UPDATE upi_qr_configs SET is_primary = FALSE, updated_at = NOW() WHERE qr_code_key != ${key}`;
    }

    const [updated] = await tx`
      INSERT INTO upi_qr_configs (qr_code_key, label, upi_id, qr_image_url, is_active, is_primary, updated_at)
      VALUES (
        ${key},
        ${label || (key === 'qr1' ? 'Primary UPI QR' : 'Secondary UPI QR')},
        ${upi_id || ''},
        ${qr_image_url || null},
        ${is_active !== undefined ? Boolean(is_active) : true},
        ${Boolean(is_primary)},
        NOW()
      )
      ON CONFLICT (qr_code_key) DO UPDATE SET
        label = COALESCE(EXCLUDED.label, upi_qr_configs.label),
        upi_id = COALESCE(EXCLUDED.upi_id, upi_qr_configs.upi_id),
        qr_image_url = CASE 
          WHEN EXCLUDED.qr_image_url IS NOT NULL THEN EXCLUDED.qr_image_url 
          ELSE upi_qr_configs.qr_image_url 
        END,
        is_active = COALESCE(EXCLUDED.is_active, upi_qr_configs.is_active),
        is_primary = COALESCE(EXCLUDED.is_primary, upi_qr_configs.is_primary),
        updated_at = NOW()
      RETURNING *
    `;

    return updated;
  });
}

/**
 * Fetches company bank settings and active payment method flags.
 */
export async function getCompanyBankSettings() {
  await initUpiQrSchema();
  const rows = await sql`
    SELECT 
      setting_key, account_name, bank_name, account_number, ifsc_code, branch_name,
      enable_primary_upi, enable_secondary_upi, enable_bank_transfer, enable_payment_gateway,
      updated_at
    FROM company_bank_settings
    WHERE setting_key = 'default_bank'
    LIMIT 1
  `;
  if (rows.length > 0) return rows[0];
  return {
    setting_key: 'default_bank',
    account_name: 'MMR CONSTRUCTIONS PRIVATE LIMITED',
    bank_name: 'HDFC Bank Ltd.',
    account_number: '50200088921832',
    ifsc_code: 'HDFC0001234',
    branch_name: 'Civil Lines, Kanpur',
    enable_primary_upi: true,
    enable_secondary_upi: true,
    enable_bank_transfer: true,
    enable_payment_gateway: true
  };
}

/**
 * Saves or updates company bank settings and active payment method flags.
 */
export async function saveCompanyBankSettings({
  account_name, bank_name, account_number, ifsc_code, branch_name,
  enable_primary_upi, enable_secondary_upi, enable_bank_transfer, enable_payment_gateway
}) {
  await initUpiQrSchema();
  const [updated] = await sql`
    INSERT INTO company_bank_settings (
      setting_key, account_name, bank_name, account_number, ifsc_code, branch_name,
      enable_primary_upi, enable_secondary_upi, enable_bank_transfer, enable_payment_gateway, updated_at
    ) VALUES (
      'default_bank',
      ${account_name || 'MMR CONSTRUCTIONS PRIVATE LIMITED'},
      ${bank_name || 'HDFC Bank Ltd.'},
      ${account_number || '50200088921832'},
      ${ifsc_code || 'HDFC0001234'},
      ${branch_name || 'Civil Lines, Kanpur'},
      ${enable_primary_upi !== undefined ? Boolean(enable_primary_upi) : true},
      ${enable_secondary_upi !== undefined ? Boolean(enable_secondary_upi) : true},
      ${enable_bank_transfer !== undefined ? Boolean(enable_bank_transfer) : true},
      ${enable_payment_gateway !== undefined ? Boolean(enable_payment_gateway) : true},
      NOW()
    )
    ON CONFLICT (setting_key) DO UPDATE SET
      account_name = COALESCE(EXCLUDED.account_name, company_bank_settings.account_name),
      bank_name = COALESCE(EXCLUDED.bank_name, company_bank_settings.bank_name),
      account_number = COALESCE(EXCLUDED.account_number, company_bank_settings.account_number),
      ifsc_code = COALESCE(EXCLUDED.ifsc_code, company_bank_settings.ifsc_code),
      branch_name = COALESCE(EXCLUDED.branch_name, company_bank_settings.branch_name),
      enable_primary_upi = COALESCE(EXCLUDED.enable_primary_upi, company_bank_settings.enable_primary_upi),
      enable_secondary_upi = COALESCE(EXCLUDED.enable_secondary_upi, company_bank_settings.enable_secondary_upi),
      enable_bank_transfer = COALESCE(EXCLUDED.enable_bank_transfer, company_bank_settings.enable_bank_transfer),
      enable_payment_gateway = COALESCE(EXCLUDED.enable_payment_gateway, company_bank_settings.enable_payment_gateway),
      updated_at = NOW()
    RETURNING *
  `;
  return updated;
}

export default {
  initUpiQrSchema,
  getAllQrConfigs,
  getActiveQrConfigs,
  saveQrConfig,
  getCompanyBankSettings,
  saveCompanyBankSettings
};

