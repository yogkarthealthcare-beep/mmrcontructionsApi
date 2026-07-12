import sql from "../db.js";
import { encrypt } from "../utils/encryption.js";

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
const callbackUrl = process.env.RAZORPAY_CALLBACK_URL || "https://mmrcontructions-api-self.vercel.app/api/payment/razorpay/verify";
const webhookUrl = process.env.RAZORPAY_WEBHOOK_URL || "https://mmrcontructions-api-self.vercel.app/api/payment/razorpay/webhook";

if (!keyId || !keySecret) {
  console.error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required.");
  process.exit(1);
}

try {
  const encryptedSecret = encrypt(keySecret);
  const [row] = await sql`
    INSERT INTO payment_gateway_configs (
      gateway_name, display_name, is_enabled, is_default,
      allow_user_selection, fallback_enabled, priority, status,
      environment_mode, public_key, encrypted_secret_key,
      callback_url, webhook_url, min_customer_fund_amount, min_associate_fund_amount
    ) VALUES (
      'razorpay', 'Razorpay', TRUE, FALSE,
      TRUE, FALSE, 1, 'active',
      'test', ${keyId}, ${encryptedSecret},
      ${callbackUrl}, ${webhookUrl}, 100, 100
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
    RETURNING id, gateway_name, display_name, status, environment_mode, public_key, callback_url, webhook_url, is_default
  `;

  console.log(JSON.stringify({
    success: true,
    gateway_name: row.gateway_name,
    display_name: row.display_name,
    status: row.status,
    environment_mode: row.environment_mode,
    public_key: row.public_key,
    callback_url: row.callback_url,
    webhook_url: row.webhook_url,
    is_default: row.is_default,
    secret_saved: true,
  }, null, 2));
} catch (error) {
  console.error("Failed to upsert Razorpay gateway:", {
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
