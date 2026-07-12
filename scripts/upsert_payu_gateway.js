import sql from "../db.js";
import { encrypt } from "../utils/encryption.js";

const key = process.env.PAYU_MERCHANT_KEY;
const salt = process.env.PAYU_SALT;
const callbackUrl = process.env.PAYU_CALLBACK_URL || "https://mmrcontructions-api-self.vercel.app/api/payment/payu/verify";

if (!key || !salt) {
  console.error("PAYU_MERCHANT_KEY and PAYU_SALT are required.");
  process.exit(1);
}

try {
  const encryptedSalt = encrypt(salt);
  const [row] = await sql`
    INSERT INTO payment_gateway_configs (
      gateway_name, display_name, is_enabled, is_default,
      allow_user_selection, fallback_enabled, priority, status,
      environment_mode, public_key, encrypted_secret_key,
      callback_url, webhook_url, min_customer_fund_amount, min_associate_fund_amount
    ) VALUES (
      'payu', 'PayU', TRUE, FALSE,
      TRUE, FALSE, 3, 'active',
      'test', ${key}, ${encryptedSalt},
      ${callbackUrl}, ${callbackUrl}, 100, 100
    )
    ON CONFLICT (gateway_name) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      is_enabled = TRUE,
      allow_user_selection = TRUE,
      status = 'active',
      environment_mode = 'test',
      public_key = EXCLUDED.public_key,
      encrypted_secret_key = EXCLUDED.encrypted_secret_key,
      callback_url = EXCLUDED.callback_url,
      webhook_url = EXCLUDED.webhook_url,
      priority = COALESCE(payment_gateway_configs.priority, EXCLUDED.priority),
      updated_at = NOW()
    RETURNING id, gateway_name, display_name, status, environment_mode, public_key, callback_url
  `;

  console.log(JSON.stringify({
    success: true,
    gateway_name: row.gateway_name,
    display_name: row.display_name,
    status: row.status,
    environment_mode: row.environment_mode,
    public_key: row.public_key,
    callback_url: row.callback_url,
    secret_saved: true,
  }, null, 2));
} catch (error) {
  console.error("Failed to upsert PayU gateway:", {
    name: error.name,
    message: error.message,
    code: error.code,
    detail: error.detail,
    hint: error.hint,
  });
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
