import "../config/loadEnv.js";
import jwt from "jsonwebtoken";
import sql from "../db.js";

const baseUrl = process.env.PRODUCTION_API_URL || "https://api.mmrconstructions.in";

try {
  const [admin] = await sql`
    SELECT a.admin_id, a.email, a.full_name, r.role_name AS role
    FROM admin_users a
    JOIN admin_roles r ON r.role_id = a.role_id
    WHERE a.is_active = TRUE
    ORDER BY a.admin_id
    LIMIT 1`;

  const columns = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_gateway_configs'
    ORDER BY ordinal_position`;

  const [cashfree] = await sql`
    SELECT
      gateway_name, display_name, status, environment_mode,
      public_key IS NOT NULL AS has_public_key,
      encrypted_secret_key IS NOT NULL AS has_secret_key,
      encrypted_client_secret IS NOT NULL AS has_client_secret,
      encrypted_webhook_secret IS NOT NULL AS has_webhook_secret,
      callback_url, webhook_url, success_url, failure_url, cancel_url
    FROM payment_gateway_configs
    WHERE gateway_name = 'cashfree'`;

  const token = jwt.sign(
    { admin_id: admin.admin_id, email: admin.email, full_name: admin.full_name, role: admin.role },
    process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET,
    { expiresIn: "5m" },
  );
  const response = await fetch(`${baseUrl}/api/admin/payment-gateways/cashfree`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();

  console.log(JSON.stringify({
    columns,
    cashfree,
    live: {
      status: response.status,
      body: (() => {
        try {
          const parsed = JSON.parse(text);
          if (parsed?.data) {
            parsed.data = {
              ...parsed.data,
              public_key: parsed.data.public_key ? "[MASKED]" : null,
              key_id: parsed.data.key_id ? "[MASKED]" : null,
              client_id: parsed.data.client_id ? "[MASKED]" : null,
              secret_key: parsed.data.secret_key ? "[MASKED]" : null,
              key_secret: parsed.data.key_secret ? "[MASKED]" : null,
              client_secret: parsed.data.client_secret ? "[MASKED]" : null,
              webhook_secret: parsed.data.webhook_secret ? "[MASKED]" : null,
            };
          }
          return parsed;
        } catch {
          return text.slice(0, 500);
        }
      })(),
    },
  }, null, 2));
} finally {
  await sql.end();
}
