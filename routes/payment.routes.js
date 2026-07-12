import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import sql from "../db.js";
import { encrypt, decrypt } from "../utils/encryption.js";
import GatewayFactory from "../payment/GatewayFactory.js";
import { z } from "zod";

const router = express.Router();

// ─── HELPERS ──────────────────────────────────────────────────
const ok = (res, data, msg = "Success", status = 200) =>
  res.status(status).json({ success: true, message: msg, data });

const err = (res, msg = "Server error", status = 500) =>
  res.status(status).json({ success: false, message: msg });

// ─── RATE LIMITER ─────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(key, maxAttempts = 15, windowMs = 60 * 1000) {
  const now = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count++;
  rateLimitMap.set(key, entry);
  return entry.count > maxAttempts;
}

const paymentRateLimiter = (req, res, next) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const limitKey = `rate_limit:${ip}:${req.path}`;
  if (rateLimit(limitKey, 15, 60 * 1000)) {
    return res.status(429).json({ success: false, message: "Too many requests. Please try again later." });
  }
  next();
};

// ─── ZOD SCHEMAS & VALIDATION ─────────────────────────────────
const initiateSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  amount: z.union([z.number(), z.string()]).transform((val) => Number(val)).refine((val) => val > 0, "amount must be greater than 0"),
  gateway_name: z.string().optional().nullable(),
  customer_name: z.string().min(1, "customer_name is required"),
  customer_email: z.string().email("Invalid email format"),
  customer_mobile: z.string().min(10, "Invalid mobile number format").max(15, "Invalid mobile number format"),
});

const rzpCreateOrderSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  amount: z.union([z.number(), z.string()]).transform((val) => Number(val)).refine((val) => val > 0, "amount must be greater than 0"),
  customer_name: z.string().optional().nullable(),
  customer_email: z.string().email("Invalid email format").optional().nullable(),
  customer_mobile: z.string().optional().nullable(),
});

const cfCreateOrderSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  amount: z.union([z.number(), z.string()]).transform((val) => Number(val)).refine((val) => val > 0, "amount must be greater than 0"),
  customer_name: z.string().optional().nullable(),
  customer_email: z.string().email("Invalid email format").optional().nullable(),
  customer_mobile: z.string().optional().nullable(),
});

const rzpVerifySchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  razorpay_order_id: z.string().min(1, "razorpay_order_id is required"),
  razorpay_payment_id: z.string().min(1, "razorpay_payment_id is required"),
  razorpay_signature: z.string().min(1, "razorpay_signature is required"),
});

const cfVerifySchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
});

const payuCreateOrderSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  amount: z.union([z.number(), z.string()]).transform((val) => Number(val)).refine((val) => val > 0, "amount must be greater than 0"),
  customer_name: z.string().optional().nullable(),
  customer_email: z.string().email("Invalid email format").optional().nullable(),
  customer_mobile: z.string().optional().nullable(),
});

const refundSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  amount: z.union([z.number(), z.string()]).transform((val) => Number(val)).refine((val) => val > 0, "amount must be greater than 0").optional(),
  reason: z.string().optional(),
});

const gatewayConfigSchema = z.object({
  gateway_name: z.string().min(1, "gateway_name is required"),
  display_name: z.string().optional().nullable(),
  is_enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
  allow_user_selection: z.boolean().optional(),
  fallback_enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  status: z.string().optional(),
  environment_mode: z.string().optional(),
  mode: z.string().optional(),
  public_key: z.string().optional().nullable(),
  key_id: z.string().optional().nullable(),
  client_id: z.string().optional().nullable(),
  secret_key: z.string().optional().nullable(),
  key_secret: z.string().optional().nullable(),
  client_secret: z.string().optional().nullable(),
  webhook_secret: z.string().optional().nullable(),
  callback_url: z.string().optional().nullable(),
  webhook_url: z.string().optional().nullable(),
  success_url: z.string().optional().nullable(),
  failure_url: z.string().optional().nullable(),
  cancel_url: z.string().optional().nullable(),
  min_customer_fund_amount: z.union([z.number(), z.string()]).transform((val) => Number(val)).refine((val) => val >= 0, "min_customer_fund_amount must be non-negative").optional(),
  min_associate_fund_amount: z.union([z.number(), z.string()]).transform((val) => Number(val)).refine((val) => val >= 0, "min_associate_fund_amount must be non-negative").optional(),
  extra_config: z.any().optional(),
});

const validateBody = (schema) => (req, res, next) => {
  try {
    req.body = schema.parse(req.body);
    next();
  } catch (e) {
    const errorMsg = e.errors ? e.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(', ') : e.message;
    return res.status(400).json({
      success: false,
      message: `Validation error: ${errorMsg}`
    });
  }
};

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "••••••••" + key.slice(-4);
}

function maskConfig(config) {
  if (!config) return null;
  let secretKey = null;
  let clientSecret = null;
  let webhookSecret = null;
  try {
    secretKey = config.encrypted_secret_key ? decrypt(config.encrypted_secret_key) : null;
    clientSecret = config.encrypted_client_secret ? decrypt(config.encrypted_client_secret) : null;
    webhookSecret = config.encrypted_webhook_secret ? decrypt(config.encrypted_webhook_secret) : null;
  } catch (e) {
    console.error(`Failed to decrypt credentials for config ID: ${config.id}`, e.message);
  }

  return {
    id: config.id,
    gateway_name: config.gateway_name,
    display_name: config.display_name,
    is_enabled: config.is_enabled,
    is_default: config.is_default,
    allow_user_selection: config.allow_user_selection,
    fallback_enabled: config.fallback_enabled,
    priority: config.priority,
    status: config.status,
    environment_mode: config.environment_mode,
    mode: config.environment_mode,
    public_key: maskKey(config.public_key),
    key_id: maskKey(config.public_key),
    client_id: maskKey(config.public_key),
    secret_key: maskKey(secretKey),
    key_secret: maskKey(secretKey),
    client_secret: maskKey(clientSecret),
    webhook_secret: maskKey(webhookSecret),
    callback_url: config.callback_url,
    webhook_url: config.webhook_url,
    success_url: config.success_url,
    failure_url: config.failure_url,
    cancel_url: config.cancel_url,
    min_customer_fund_amount: Number(config.min_customer_fund_amount ?? 100),
    min_associate_fund_amount: Number(config.min_associate_fund_amount ?? 100),
    extra_config: config.extra_config,
    created_at: config.created_at,
    updated_at: config.updated_at,
  };
}

const supportedGatewayDefaults = {
  razorpay: {
    display_name: "Razorpay",
    environment_mode: "test",
    priority: 1,
  },
  cashfree: {
    display_name: "Cashfree",
    environment_mode: "sandbox",
    priority: 2,
  },
  payu: {
    display_name: "PayU",
    environment_mode: "test",
    priority: 3,
  },
};

function getGatewayLogo(gatewayName) {
  const logos = {
    razorpay: "https://razorpay.com/favicon.ico",
    cashfree: "https://www.cashfree.com/favicon.ico",
    payu: "https://payu.in/favicon.ico",
  };
  return logos[String(gatewayName || "").toLowerCase()] || "";
}

async function getOrCreateSupportedGatewayConfig(gatewayName) {
  const normalizedName = String(gatewayName || "").toLowerCase();
  const defaults = supportedGatewayDefaults[normalizedName];
  if (!defaults) return null;

  const [config] = await sql`
    INSERT INTO payment_gateway_configs (
      gateway_name, display_name, is_enabled, is_default,
      allow_user_selection, fallback_enabled, priority, status,
      environment_mode, min_customer_fund_amount, min_associate_fund_amount
    ) VALUES (
      ${normalizedName}, ${defaults.display_name}, FALSE, FALSE,
      TRUE, FALSE, ${defaults.priority}, 'inactive',
      ${defaults.environment_mode}, 100, 100
    )
    ON CONFLICT (gateway_name) DO UPDATE SET
      display_name = COALESCE(payment_gateway_configs.display_name, EXCLUDED.display_name),
      environment_mode = COALESCE(payment_gateway_configs.environment_mode, EXCLUDED.environment_mode)
    RETURNING *`;
  return config;
}

// ─── LOGGING HELPERS ──────────────────────────────────────────
async function logPaymentEvent(orderId, gatewayName, logType, reqPayload, resPayload, req) {
  try {
    const ipAddress = req?.ip || req?.headers["x-forwarded-for"] || null;
    const userAgent = req?.headers["user-agent"] || null;

    await sql`
      INSERT INTO payment_logs (
        order_id, gateway_name, log_type, request_payload, response_payload, ip_address, user_agent
      ) VALUES (
        ${orderId || null}, ${gatewayName || null}, ${logType}, 
        ${reqPayload ? JSON.stringify(reqPayload) : null}, 
        ${resPayload ? JSON.stringify(resPayload) : null}, 
        ${ipAddress}, ${userAgent}
      )
    `;
  } catch (e) {
    console.error("[logPaymentEvent Error]", e.message);
  }
}

async function logGatewayAudit(adminId, gatewayName, actionType, oldValue, newValue, req) {
  try {
    const ipAddress = req?.ip || req?.headers["x-forwarded-for"] || null;
    const userAgent = req?.headers["user-agent"] || null;

    await sql`
      INSERT INTO payment_gateway_audit_logs (
        admin_id, gateway_name, action_type, old_value, new_value, ip_address, user_agent
      ) VALUES (
        ${adminId || null}, ${gatewayName || null}, ${actionType}, 
        ${oldValue ? JSON.stringify(oldValue) : null}, 
        ${newValue ? JSON.stringify(newValue) : null}, 
        ${ipAddress}, ${userAgent}
      )
    `;
  } catch (e) {
    console.error("[logGatewayAudit Error]", e.message);
  }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────
async function creditWalletAddFundFromWebhook({ localOrderId, gatewayOrderId, gatewayPaymentId, amount, responsePayload }) {
  const [txRecord] = await sql`
    SELECT *
    FROM wallet_transactions
    WHERE source = 'Add Fund'
      AND (
        payment_order_id = ${localOrderId || ""}
        OR gateway_response->>'gateway_order_id' = ${gatewayOrderId || ""}
      )
    LIMIT 1
  `;

  if (!txRecord) return false;
  if (txRecord.status === "success") return true;

  const expectedAmount = Number(txRecord.amount);
  const paidAmount = amount === undefined || amount === null ? expectedAmount : Number(amount);
  if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - expectedAmount) > 0.01) {
    await sql`
      UPDATE wallet_transactions SET
        status = 'failed',
        remarks = ${`Payment amount mismatch. Expected INR ${expectedAmount}, received INR ${paidAmount}`},
        gateway_response = ${JSON.stringify(responsePayload || {})},
        updated_at = NOW()
      WHERE id = ${txRecord.id}
    `;
    return false;
  }

  await sql.begin(async (db) => {
    const [lockedTx] = await db`
      SELECT * FROM wallet_transactions WHERE id = ${txRecord.id} FOR UPDATE
    `;
    if (!lockedTx || lockedTx.status === "success") return;

    const [wallet] = await db`
      SELECT * FROM user_wallets WHERE id = ${lockedTx.wallet_id} FOR UPDATE
    `;
    if (!wallet) throw new Error("Wallet not found for webhook credit.");

    const oldAvailable = Number(wallet.available_balance);
    const newAvailable = oldAvailable + expectedAmount;
    const newAdded = Number(wallet.total_added_fund) + expectedAmount;

    const [finalWallet] = await db`
      UPDATE user_wallets SET
        available_balance = ${newAvailable},
        total_added_fund = ${newAdded},
        updated_at = NOW()
      WHERE id = ${wallet.id}
      RETURNING *
    `;

    await db`
      UPDATE wallet_transactions SET
        status = 'success',
        balance_before = ${oldAvailable},
        balance_after = ${newAvailable},
        payment_transaction_id = ${gatewayPaymentId || null},
        gateway_response = ${JSON.stringify(responsePayload || {})},
        updated_at = NOW()
      WHERE id = ${lockedTx.id}
    `;

    await db`
      INSERT INTO wallet_audit_logs (user_id, admin_id, action_type, old_value, new_value)
      VALUES (${lockedTx.user_id}, null, 'CREDIT_ADD_FUND_WEBHOOK', ${JSON.stringify(wallet)}, ${JSON.stringify(finalWallet)})
    `;
  });

  return true;
}

function authUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

function authAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No admin token provided" });
  }
  const token = authHeader.split(" ")[1];
  const adminSecret = process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET;
  try {
    req.admin = jwt.verify(token, adminSecret);
    if (!req.admin || !req.admin.role) {
      return res.status(403).json({ success: false, message: "Forbidden - Admin access required" });
    }
    next();
  } catch (err) {
    try {
      req.admin = jwt.verify(token, process.env.JWT_SECRET);
      if (!req.admin || !req.admin.role) {
        return res.status(403).json({ success: false, message: "Forbidden - Admin access required" });
      }
      next();
    } catch {
      return res.status(401).json({ success: false, message: "Invalid or expired admin token" });
    }
  }
}

// ─── USER APIS ────────────────────────────────────────────────

// GET /api/payment/gateways - Return active gateways
router.get("/payment/gateways", async (req, res) => {
  try {
    const activeConfigs = await sql`
      SELECT gateway_name, display_name, status, environment_mode, is_default, allow_user_selection,
             min_customer_fund_amount, min_associate_fund_amount
      FROM payment_gateway_configs
      WHERE is_enabled = true AND status = 'active'
      ORDER BY priority ASC
    `;

    const mapped = activeConfigs.map((c) => ({
      gateway_name: c.gateway_name,
      display_name: c.display_name,
      status: c.status,
      mode: c.environment_mode,
      is_default: c.is_default,
      allow_user_selection: c.allow_user_selection,
      min_customer_fund_amount: Number(c.min_customer_fund_amount ?? 100),
      min_associate_fund_amount: Number(c.min_associate_fund_amount ?? 100),
      logo: getGatewayLogo(c.gateway_name),
    }));

    return ok(res, mapped, "Active payment gateways loaded.");
  } catch (e) {
    console.error("Load gateways error:", e);
    return err(res, "Failed to load payment gateways.");
  }
});

// POST /api/payment/initiate - Initiate a payment transaction
router.post("/payment/initiate", authUser, paymentRateLimiter, validateBody(initiateSchema), async (req, res) => {
  const { order_id, amount, gateway_name, customer_name, customer_email, customer_mobile } = req.body;

  try {
    // Idempotency: check if transaction already exists for this order
    const [existing] = await sql`
      SELECT * FROM payment_transactions WHERE order_id = ${order_id}
    `;

    if (existing) {
      if (existing.payment_status === "success" || existing.payment_status === "captured") {
        return res.status(400).json({ success: false, message: "This order has already been successfully paid." });
      }

      // If pending, check if the amount matches and reuse it
      if (existing.payment_status === "pending" && Number(existing.amount) === Number(amount)) {
        await logPaymentEvent(order_id, existing.gateway_name, "INITIATE_REUSE", req.body, existing.gateway_response, req);
        return ok(res, {
          transaction_id: existing.id,
          order_id: existing.order_id,
          gateway_name: existing.gateway_name,
          gateway_order_id: existing.gateway_order_id,
          checkout_details: existing.gateway_response?.checkout_details || existing.gateway_response,
        }, "Re-initiating existing pending payment.");
      }
    }

    // Resolve gateway strategy based on config priority/defaults
    const gatewayInstance = await GatewayFactory.resolveGateway(gateway_name);
    const selectedGatewayName = gatewayInstance.config.gateway_name;

    // Create order on payment gateway
    const customerDetails = {
      name: customer_name || "Customer",
      email: customer_email || "customer@example.com",
      phone: customer_mobile || "9999999999",
      customer_id: req.user.user_id || order_id,
    };

    // Construct callback url
    const callbackUrl = gatewayInstance.config.callback_url || `${req.protocol}://${req.get("host")}/api/payment/${selectedGatewayName}/verify`;

    const r = await gatewayInstance.createOrder(order_id, amount, customerDetails, callbackUrl);

    // Save transaction inside a DB transaction block
    let newTx;
    await sql.begin(async (tx) => {
      // If order had a previous failed transaction, delete or mark it superseded. Let's delete to enforce UNIQUE order_id constraint.
      if (existing) {
        await tx`DELETE FROM payment_transactions WHERE id = ${existing.id}`;
      }

      [newTx] = await tx`
        INSERT INTO payment_transactions (
          order_id, gateway_name, amount, customer_name, customer_email, customer_mobile, 
          payment_status, gateway_order_id, gateway_response, created_by
        ) VALUES (
          ${order_id}, ${selectedGatewayName}, ${amount}, ${customerDetails.name}, 
          ${customerDetails.email}, ${customerDetails.phone}, 'pending', 
          ${r.gateway_order_id}, ${JSON.stringify(r)}, ${req.user.user_id || null}
        ) RETURNING *
      `;
    });

    await logPaymentEvent(order_id, selectedGatewayName, "INITIATE_SUCCESS", req.body, r, req);

    return ok(res, {
      transaction_id: newTx.id,
      order_id: newTx.order_id,
      gateway_name: selectedGatewayName,
      gateway_order_id: newTx.gateway_order_id,
      checkout_details: r.checkout_details || r,
    }, "Payment initiated successfully.");
  } catch (error) {
    console.error("Initiate payment error:", error);
    await logPaymentEvent(order_id, gateway_name || "unknown", "INITIATE_FAILURE", req.body, { error: error.message }, req);
    return res.status(500).json({ success: false, message: error.message || "Failed to initiate payment." });
  }
});

// GET /api/payment/status/:orderId - Return payment status
router.get("/payment/status/:orderId", authUser, async (req, res) => {
  try {
    const [tx] = await sql`
      SELECT id, order_id, gateway_name, amount, currency, payment_status, gateway_payment_id, failure_reason, created_at, updated_at
      FROM payment_transactions 
      WHERE order_id = ${req.params.orderId}
    `;

    if (!tx) {
      return res.status(404).json({ success: false, message: "Transaction not found." });
    }

    return ok(res, tx, "Payment status retrieved.");
  } catch (e) {
    console.error("Check status error:", e);
    return err(res, "Failed to retrieve status.");
  }
});

// ─── GATEWAY SPECIFIC APIS ────────────────────────────────────

// Razorpay Order Creation
router.post("/payment/razorpay/create-order", authUser, paymentRateLimiter, validateBody(rzpCreateOrderSchema), async (req, res) => {
  const { order_id, amount, customer_name, customer_email, customer_mobile } = req.body;

  try {
    // Check if order already paid
    const [existing] = await sql`
      SELECT payment_status FROM payment_transactions WHERE order_id = ${order_id}
    `;
    if (existing && ["success", "captured"].includes(existing.payment_status)) {
      return res.status(400).json({ success: false, message: "This order has already been successfully paid." });
    }

    const gateway = await GatewayFactory.getGatewayInstance("razorpay");
    const customer = { name: customer_name, email: customer_email, phone: customer_mobile };
    const callback = gateway.config.callback_url || "";
    const result = await gateway.createOrder(order_id, amount, customer, callback);

    await sql`
      INSERT INTO payment_transactions (
        order_id, gateway_name, amount, customer_name, customer_email, customer_mobile, 
        payment_status, gateway_order_id, gateway_response, created_by
      ) VALUES (
        ${order_id}, 'razorpay', ${amount}, ${customer_name || null}, 
        ${customer_email || null}, ${customer_mobile || null}, 'pending', 
        ${result.gateway_order_id}, ${JSON.stringify(result)}, ${req.user.user_id || null}
      ) ON CONFLICT (order_id) DO UPDATE SET 
        gateway_order_id = EXCLUDED.gateway_order_id,
        gateway_response = EXCLUDED.gateway_response,
        updated_at = NOW()
    `;

    return ok(res, result, "Razorpay order created.");
  } catch (e) {
    console.error("Razorpay create order failed:", e);
    return err(res, e.message);
  }
});

// Razorpay Verification
router.post("/payment/razorpay/verify", authUser, paymentRateLimiter, validateBody(rzpVerifySchema), async (req, res) => {
  const { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  try {
    const gateway = await GatewayFactory.getGatewayInstance("razorpay");
    const result = await gateway.verifyPayment(order_id, {}, req.body);

    await sql.begin(async (tx) => {
      await tx`
        UPDATE payment_transactions SET
          payment_status = 'success',
          gateway_payment_id = ${razorpay_payment_id},
          gateway_signature = ${razorpay_signature},
          gateway_response = ${JSON.stringify(result.raw_response)},
          updated_at = NOW()
        WHERE order_id = ${order_id}
      `;
    });

    await logPaymentEvent(order_id, "razorpay", "VERIFY_SUCCESS", req.body, result, req);
    return ok(res, result, "Razorpay payment verified successfully.");
  } catch (error) {
    console.error("Razorpay verification failed:", error);
    await sql`
      UPDATE payment_transactions SET
        payment_status = 'failed',
        failure_reason = ${error.message},
        updated_at = NOW()
      WHERE order_id = ${order_id}
    `;
    await logPaymentEvent(order_id, "razorpay", "VERIFY_FAILURE", req.body, { error: error.message }, req);
    return res.status(400).json({ success: false, message: error.message });
  }
});

// Razorpay Webhook
router.post("/payment/razorpay/webhook", async (req, res) => {
  const rawBody = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);

  try {
    const gateway = await GatewayFactory.getGatewayInstance("razorpay");
    const isValid = await gateway.verifyWebhook(req.headers, rawBody);

    if (!isValid) {
      return res.status(400).send("Invalid Signature");
    }

    const payload = req.body;
    const event = payload.event;
    const rzpPayment = payload.payload?.payment?.entity;
    const rzpOrderId = rzpPayment?.order_id;

    if (!rzpOrderId) {
      return res.status(200).send("OK - No Order ID");
    }

    const [tx] = await sql`
      SELECT order_id FROM payment_transactions WHERE gateway_order_id = ${rzpOrderId}
    `;

    const localOrderId = tx ? tx.order_id : rzpOrderId;

    if (event === "payment.captured" || event === "order.paid") {
      await sql`
        UPDATE payment_transactions SET
          payment_status = 'success',
          gateway_payment_id = ${rzpPayment.id},
          gateway_response = ${JSON.stringify(payload)},
          updated_at = NOW()
        WHERE gateway_order_id = ${rzpOrderId}
      `;
      await creditWalletAddFundFromWebhook({
        localOrderId,
        gatewayOrderId: rzpOrderId,
        gatewayPaymentId: rzpPayment.id,
        amount: rzpPayment.amount ? Number(rzpPayment.amount) / 100 : undefined,
        responsePayload: payload,
      });
      await logPaymentEvent(localOrderId, "razorpay", "WEBHOOK_SUCCESS", payload, { event }, req);
    } else if (event === "payment.failed") {
      await sql`
        UPDATE payment_transactions SET
          payment_status = 'failed',
          failure_reason = ${rzpPayment.error_description || "Webhook reported failure"},
          gateway_response = ${JSON.stringify(payload)},
          updated_at = NOW()
        WHERE gateway_order_id = ${rzpOrderId}
      `;
      await sql`
        UPDATE wallet_transactions SET
          status = 'failed',
          remarks = ${rzpPayment.error_description || "Payment failed reported by Razorpay"},
          gateway_response = ${JSON.stringify(payload)},
          updated_at = NOW()
        WHERE source = 'Add Fund'
          AND status = 'pending'
          AND gateway_response->>'gateway_order_id' = ${rzpOrderId}
      `;
      await logPaymentEvent(localOrderId, "razorpay", "WEBHOOK_FAILED", payload, { event }, req);
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Razorpay Webhook Error:", error);
    return res.status(500).send("Webhook handling error");
  }
});

// Cashfree Order Creation
router.post("/payment/cashfree/create-order", authUser, paymentRateLimiter, validateBody(cfCreateOrderSchema), async (req, res) => {
  const { order_id, amount, customer_name, customer_email, customer_mobile } = req.body;

  try {
    // Check if order already paid
    const [existing] = await sql`
      SELECT payment_status FROM payment_transactions WHERE order_id = ${order_id}
    `;
    if (existing && ["success", "captured"].includes(existing.payment_status)) {
      return res.status(400).json({ success: false, message: "This order has already been successfully paid." });
    }

    const gateway = await GatewayFactory.getGatewayInstance("cashfree");
    const customer = { name: customer_name, email: customer_email, phone: customer_mobile, customer_id: req.user.user_id };
    const callback = gateway.config.callback_url || "";
    const result = await gateway.createOrder(order_id, amount, customer, callback);

    await sql`
      INSERT INTO payment_transactions (
        order_id, gateway_name, amount, customer_name, customer_email, customer_mobile, 
        payment_status, gateway_order_id, gateway_response, created_by
      ) VALUES (
        ${order_id}, 'cashfree', ${amount}, ${customer_name || null}, 
        ${customer_email || null}, ${customer_mobile || null}, 'pending', 
        ${result.gateway_order_id}, ${JSON.stringify(result)}, ${req.user.user_id || null}
      ) ON CONFLICT (order_id) DO UPDATE SET 
        gateway_order_id = EXCLUDED.gateway_order_id,
        gateway_response = EXCLUDED.gateway_response,
        updated_at = NOW()
    `;

    return ok(res, result, "Cashfree order session generated.");
  } catch (e) {
    console.error("Cashfree create order failed:", e);
    return err(res, e.message);
  }
});

// Cashfree Verification
router.post("/payment/cashfree/verify", authUser, paymentRateLimiter, validateBody(cfVerifySchema), async (req, res) => {
  const { order_id } = req.body;

  try {
    const gateway = await GatewayFactory.getGatewayInstance("cashfree");
    const result = await gateway.verifyPayment(order_id, {}, {});

    await sql.begin(async (tx) => {
      await tx`
        UPDATE payment_transactions SET
          payment_status = 'success',
          gateway_payment_id = ${result.gateway_payment_id},
          gateway_response = ${JSON.stringify(result.raw_response)},
          updated_at = NOW()
        WHERE order_id = ${order_id}
      `;
    });

    await logPaymentEvent(order_id, "cashfree", "VERIFY_SUCCESS", req.body, result, req);
    return ok(res, result, "Cashfree payment verified successfully.");
  } catch (error) {
    console.error("Cashfree verification failed:", error);
    await sql`
      UPDATE payment_transactions SET
        payment_status = 'failed',
        failure_reason = ${error.message},
        updated_at = NOW()
      WHERE order_id = ${order_id}
    `;
    await logPaymentEvent(order_id, "cashfree", "VERIFY_FAILURE", req.body, { error: error.message }, req);
    return res.status(400).json({ success: false, message: error.message });
  }
});

// Cashfree Webhook
router.post("/payment/cashfree/webhook", async (req, res) => {
  const rawBody = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);

  try {
    const gateway = await GatewayFactory.getGatewayInstance("cashfree");
    const isValid = await gateway.verifyWebhook(req.headers, rawBody);

    if (!isValid) {
      return res.status(400).send("Invalid Signature");
    }

    const payload = req.body;
    const type = payload.type;
    const data = payload.data || {};
    const cfOrder = data.order || {};
    const orderId = cfOrder.order_id;

    if (!orderId) {
      return res.status(200).send("OK");
    }

    if (type === "payment.success" || type === "ORDER_PAID") {
      const paymentObj = data.payment || {};
      await sql`
        UPDATE payment_transactions SET
          payment_status = 'success',
          gateway_payment_id = ${paymentObj.cf_payment_id || String(orderId)},
          gateway_response = ${JSON.stringify(payload)},
          updated_at = NOW()
        WHERE order_id = ${orderId}
      `;
      await creditWalletAddFundFromWebhook({
        localOrderId: orderId,
        gatewayOrderId: orderId,
        gatewayPaymentId: paymentObj.cf_payment_id || String(orderId),
        amount: cfOrder.order_amount,
        responsePayload: payload,
      });
      await logPaymentEvent(orderId, "cashfree", "WEBHOOK_SUCCESS", payload, { type }, req);
    } else if (type === "payment.failed" || type === "ORDER_FAILED") {
      const paymentObj = data.payment || {};
      const failureReason = paymentObj.payment_message || "Payment failed reported by Cashfree";
      await sql`
        UPDATE payment_transactions SET
          payment_status = 'failed',
          failure_reason = ${failureReason},
          gateway_response = ${JSON.stringify(payload)},
          updated_at = NOW()
        WHERE order_id = ${orderId}
      `;
      await sql`
        UPDATE wallet_transactions SET
          status = 'failed',
          remarks = ${failureReason},
          gateway_response = ${JSON.stringify(payload)},
          updated_at = NOW()
        WHERE payment_order_id = ${orderId}
          AND source = 'Add Fund'
          AND status = 'pending'
      `;
      await logPaymentEvent(orderId, "cashfree", "WEBHOOK_FAILED", payload, { type }, req);
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Cashfree Webhook Error:", error);
    return res.status(500).send("Webhook handling error");
  }
});

// ─── ADMIN GATEWAY MANAGEMENT APIS ────────────────────────────

// PayU Order Creation
router.post("/payment/payu/create-order", authUser, paymentRateLimiter, validateBody(payuCreateOrderSchema), async (req, res) => {
  const { order_id, amount, customer_name, customer_email, customer_mobile } = req.body;

  try {
    const [existing] = await sql`
      SELECT payment_status FROM payment_transactions WHERE order_id = ${order_id}
    `;
    if (existing && ["success", "captured"].includes(existing.payment_status)) {
      return res.status(400).json({ success: false, message: "This order has already been successfully paid." });
    }

    const gateway = await GatewayFactory.getGatewayInstance("payu");
    const customer = { name: customer_name, email: customer_email, phone: customer_mobile, customer_id: req.user.user_id };
    const callback = gateway.config.callback_url || `${req.protocol}://${req.get("host")}/api/payment/payu/verify`;
    const result = await gateway.createOrder(order_id, amount, customer, callback);

    await sql`
      INSERT INTO payment_transactions (
        order_id, gateway_name, amount, customer_name, customer_email, customer_mobile,
        payment_status, gateway_order_id, gateway_response, created_by
      ) VALUES (
        ${order_id}, 'payu', ${amount}, ${customer_name || null},
        ${customer_email || null}, ${customer_mobile || null}, 'pending',
        ${result.gateway_order_id}, ${JSON.stringify(result)}, ${req.user.user_id || null}
      ) ON CONFLICT (order_id) DO UPDATE SET
        gateway_order_id = EXCLUDED.gateway_order_id,
        gateway_response = EXCLUDED.gateway_response,
        updated_at = NOW()
    `;

    return ok(res, result, "PayU payment form generated.");
  } catch (e) {
    console.error("PayU create order failed:", e);
    return err(res, e.message);
  }
});

// PayU redirect callback. PayU posts x-www-form-urlencoded data here.
router.all("/payment/payu/verify", paymentRateLimiter, async (req, res) => {
  const payload = req.method === "GET" ? req.query : req.body;
  const orderId = payload.txnid || payload.order_id;
  const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:4200";

  if (!orderId) {
    return res.redirect(`${FRONTEND_URL}/payment-failed?reason=${encodeURIComponent("Missing PayU order id")}`);
  }

  try {
    const gateway = await GatewayFactory.getGatewayInstance("payu");
    const result = await gateway.verifyPayment(orderId, req.query, req.body);

    const [txRecord] = await sql`
      SELECT amount FROM payment_transactions WHERE order_id = ${orderId}
    `;

    if (txRecord) {
      const expectedAmount = Number(txRecord.amount);
      const verifiedAmount = Number(result.amount);
      if (!Number.isFinite(verifiedAmount) || Math.abs(verifiedAmount - expectedAmount) > 0.01) {
        throw new Error("Payment amount mismatch.");
      }
    }

    await sql`
      UPDATE payment_transactions SET
        payment_status = 'success',
        gateway_payment_id = ${result.gateway_payment_id},
        gateway_signature = ${result.gateway_signature},
        gateway_response = ${JSON.stringify(result.raw_response)},
        updated_at = NOW()
      WHERE order_id = ${orderId}
    `;

    await logPaymentEvent(orderId, "payu", "VERIFY_SUCCESS", payload, result, req);
    return res.redirect(`${FRONTEND_URL}/payment-success?order_id=${encodeURIComponent(orderId)}`);
  } catch (error) {
    console.error("PayU verification failed:", error);
    await sql`
      UPDATE payment_transactions SET
        payment_status = 'failed',
        failure_reason = ${error.message},
        gateway_response = ${JSON.stringify(payload || {})},
        updated_at = NOW()
      WHERE order_id = ${orderId}
    `.catch(() => {});
    await logPaymentEvent(orderId, "payu", "VERIFY_FAILURE", payload, { error: error.message }, req);
    return res.redirect(`${FRONTEND_URL}/payment-failed?order_id=${encodeURIComponent(orderId)}&reason=${encodeURIComponent(error.message)}`);
  }
});

// GET /api/admin/payment/settings - Global gateway routing settings
router.get("/admin/payment/settings", authAdmin, async (req, res) => {
  try {
    const configs = await sql`
      SELECT gateway_name, is_default, allow_user_selection, fallback_enabled
      FROM payment_gateway_configs
      ORDER BY is_default DESC, priority ASC
    `;

    return ok(res, {
      user_gateway_selection: configs.some((c) => c.allow_user_selection),
      default_gateway: configs.find((c) => c.is_default)?.gateway_name || "",
      fallback_gateway: configs.some((c) => c.fallback_enabled),
    }, "Payment settings loaded.");
  } catch (e) {
    console.error("Load payment settings failed:", e);
    return err(res, "Failed to load payment settings.");
  }
});

// POST /api/admin/payment/settings - Update global gateway routing settings
router.post("/admin/payment/settings", authAdmin, async (req, res) => {
  const { user_gateway_selection, default_gateway, fallback_gateway } = req.body;

  try {
    await sql.begin(async (tx) => {
      if (user_gateway_selection !== undefined) {
        await tx`
          UPDATE payment_gateway_configs
          SET allow_user_selection = ${Boolean(user_gateway_selection)}, updated_at = NOW()
        `;
      }

      if (fallback_gateway !== undefined) {
        await tx`
          UPDATE payment_gateway_configs
          SET fallback_enabled = ${Boolean(fallback_gateway)}, updated_at = NOW()
        `;
      }

      if (default_gateway !== undefined) {
        await tx`UPDATE payment_gateway_configs SET is_default = false, updated_at = NOW()`;
        if (default_gateway) {
          await tx`
            UPDATE payment_gateway_configs
            SET is_default = true, updated_at = NOW()
            WHERE gateway_name = ${String(default_gateway).toLowerCase()}
          `;
        }
      }
    });

    await logGatewayAudit(req.admin.admin_id, "all", "UPDATE_GLOBAL_SETTINGS", null, req.body, req);
    return ok(res, null, "Payment settings updated.");
  } catch (e) {
    console.error("Update payment settings failed:", e);
    return err(res, e.message || "Failed to update payment settings.");
  }
});

// GET /api/admin/payment-gateways - List all configurations with masked credentials
router.get("/admin/payment-gateways", authAdmin, async (req, res) => {
  try {
    const configs = await sql`
      SELECT * FROM payment_gateway_configs ORDER BY priority ASC
    `;
    const masked = configs.map(maskConfig);
    return ok(res, masked, "Gateway configurations fetched successfully.");
  } catch (e) {
    console.error("Admin load gateways error:", e);
    return err(res, "Failed to load gateway configurations.");
  }
});

// GET /api/admin/payment-gateways/:gatewayName - Fetch config by name (masked credentials)
router.get("/admin/payment-gateways/:gatewayName", authAdmin, async (req, res) => {
  try {
    const gatewayName = req.params.gatewayName.toLowerCase();
    let [config] = await sql`
      SELECT * FROM payment_gateway_configs WHERE gateway_name = ${gatewayName}
    `;

    if (!config) {
      config = await getOrCreateSupportedGatewayConfig(gatewayName);
    }
    if (!config) {
      return res.status(404).json({ success: false, message: `Unsupported gateway: ${gatewayName}.` });
    }

    return ok(res, maskConfig(config), "Gateway configuration fetched successfully.");
  } catch (e) {
    console.error("Admin fetch gateway details error:", e);
    return err(res, "Failed to load gateway details.");
  }
});

// POST /api/admin/payment-gateways - Add a new gateway configuration
router.post("/admin/payment-gateways", authAdmin, validateBody(gatewayConfigSchema), async (req, res) => {
  try {
    const {
      gateway_name,
      display_name,
      is_enabled,
      is_default,
      allow_user_selection,
      fallback_enabled,
      priority,
      status,
      environment_mode,
      mode,
      public_key,
      key_id,
      client_id,
      secret_key,
      key_secret,
      client_secret,
      webhook_secret,
      callback_url,
      webhook_url,
      success_url,
      failure_url,
      cancel_url,
      min_customer_fund_amount,
      min_associate_fund_amount,
      extra_config,
    } = req.body;

    const resolvedPublicKey = public_key || key_id || client_id || null;
    const resolvedSecretKey = secret_key || key_secret || null;
    const resolvedClientSecret = client_secret || null;
    const resolvedMode = environment_mode || mode || "sandbox";

    const encSecretKey = resolvedSecretKey ? encrypt(resolvedSecretKey) : null;
    const encClientSecret = resolvedClientSecret ? encrypt(resolvedClientSecret) : null;
    const encWebhookSecret = webhook_secret ? encrypt(webhook_secret) : null;

    let inserted;
    await sql.begin(async (tx) => {
      [inserted] = await tx`
        INSERT INTO payment_gateway_configs (
          gateway_name, display_name, is_enabled, is_default, allow_user_selection, fallback_enabled, priority, status,
          environment_mode, public_key, encrypted_secret_key, encrypted_client_secret, encrypted_webhook_secret,
          callback_url, webhook_url, success_url, failure_url, cancel_url,
          min_customer_fund_amount, min_associate_fund_amount, extra_config
        ) VALUES (
          ${gateway_name.toLowerCase()}, ${display_name || null}, ${is_enabled || false}, ${is_default || false},
          ${allow_user_selection !== false}, ${fallback_enabled || false}, ${priority || 1}, ${status || "inactive"},
          ${resolvedMode}, ${resolvedPublicKey}, ${encSecretKey}, ${encClientSecret}, ${encWebhookSecret},
          ${callback_url || null}, ${webhook_url || null}, ${success_url || null}, ${failure_url || null}, ${cancel_url || null},
          ${min_customer_fund_amount ?? 100}, ${min_associate_fund_amount ?? 100},
          ${extra_config ? JSON.stringify(extra_config) : "{}"}
        ) RETURNING *
      `;

      if (is_default) {
        await tx`
          UPDATE payment_gateway_configs SET is_default = false 
          WHERE gateway_name != ${gateway_name.toLowerCase()}
        `;
      }
    });

    // Audit log
    await logGatewayAudit(req.admin.admin_id, gateway_name, "CREATE_GATEWAY", null, maskConfig(inserted), req);

    return res.json({ success: true, message: "Gateway configuration created successfully", data: maskConfig(inserted) });
  } catch (error) {
    console.error("Create gateway error:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to create gateway configuration" });
  }
});

// PUT /api/admin/payment-gateways/:gatewayName - Update gateway configuration details
router.put("/admin/payment-gateways/:gatewayName", authAdmin, validateBody(gatewayConfigSchema.partial()), async (req, res) => {
  try {
    const gatewayName = req.params.gatewayName.toLowerCase();
    const [existing] = await sql`
      SELECT * FROM payment_gateway_configs WHERE gateway_name = ${gatewayName}
    `;
    if (!existing) {
      return res.status(404).json({ success: false, message: "Gateway configuration not found" });
    }

    const {
      display_name,
      is_enabled,
      is_default,
      allow_user_selection,
      fallback_enabled,
      priority,
      status,
      environment_mode,
      mode,
      public_key,
      key_id,
      client_id,
      secret_key,
      key_secret,
      client_secret,
      webhook_secret,
      callback_url,
      webhook_url,
      success_url,
      failure_url,
      cancel_url,
      min_customer_fund_amount,
      min_associate_fund_amount,
      extra_config,
    } = req.body;

    const updates = {};
    if (display_name !== undefined) updates.display_name = display_name;
    if (is_enabled !== undefined) updates.is_enabled = is_enabled;
    if (is_default !== undefined) updates.is_default = is_default;
    if (allow_user_selection !== undefined) updates.allow_user_selection = allow_user_selection;
    if (fallback_enabled !== undefined) updates.fallback_enabled = fallback_enabled;
    if (priority !== undefined) updates.priority = priority;
    if (status !== undefined) updates.status = status;
    if (status === "active") updates.is_enabled = true;
    if (status === "inactive") updates.is_enabled = false;
    if (environment_mode !== undefined || mode !== undefined) updates.environment_mode = environment_mode || mode;

    // Handle credential updates, filtering out masked tokens (e.g. ••••••••)
    const resolvedPublicKey = public_key ?? key_id ?? client_id;
    const resolvedSecretKey = secret_key ?? key_secret;
    if (resolvedPublicKey !== undefined && resolvedPublicKey !== "" && !resolvedPublicKey.includes("••")) {
      updates.public_key = resolvedPublicKey;
    }
    if (resolvedSecretKey !== undefined && resolvedSecretKey !== "" && !resolvedSecretKey.includes("••")) {
      updates.encrypted_secret_key = encrypt(resolvedSecretKey);
    }
    if (client_secret !== undefined && client_secret !== "" && !client_secret.includes("••")) {
      updates.encrypted_client_secret = encrypt(client_secret);
    }
    if (webhook_secret !== undefined && webhook_secret !== "" && !webhook_secret.includes("••")) {
      updates.encrypted_webhook_secret = encrypt(webhook_secret);
    }

    if (callback_url !== undefined) updates.callback_url = callback_url;
    if (webhook_url !== undefined) updates.webhook_url = webhook_url;
    if (success_url !== undefined) updates.success_url = success_url;
    if (failure_url !== undefined) updates.failure_url = failure_url;
    if (cancel_url !== undefined) updates.cancel_url = cancel_url;
    if (min_customer_fund_amount !== undefined) updates.min_customer_fund_amount = min_customer_fund_amount;
    if (min_associate_fund_amount !== undefined) updates.min_associate_fund_amount = min_associate_fund_amount;
    if (extra_config !== undefined) updates.extra_config = typeof extra_config === "string" ? JSON.parse(extra_config) : extra_config;

    updates.updated_at = new Date();

    let updated;
    if (Object.keys(updates).length > 0) {
      await sql.begin(async (tx) => {
        const result = await tx`
          UPDATE payment_gateway_configs SET ${tx(updates)}
          WHERE gateway_name = ${gatewayName}
          RETURNING *
        `;
        updated = result[0];

        if (is_default) {
          await tx`
            UPDATE payment_gateway_configs SET is_default = false 
            WHERE gateway_name != ${gatewayName}
          `;
        }
      });
    } else {
      updated = existing;
      if (is_default) {
        await sql.begin(async (tx) => {
          await tx`
            UPDATE payment_gateway_configs SET is_default = false 
            WHERE gateway_name != ${gatewayName}
          `;
          await tx`
            UPDATE payment_gateway_configs SET is_default = true 
            WHERE gateway_name = ${gatewayName}
          `;
        });
      }
    }

    // Audit log
    await logGatewayAudit(req.admin.admin_id, gatewayName, "UPDATE_GATEWAY", maskConfig(existing), maskConfig(updated), req);

    if (is_default) {
      await sql`
        UPDATE payment_gateway_configs SET is_default = false 
        WHERE gateway_name != ${gatewayName}
      `;
    }

    return res.json({ success: true, message: "Gateway configuration updated successfully", data: maskConfig(updated) });
  } catch (error) {
    console.error("Update gateway error:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to update gateway configuration" });
  }
});

// PATCH /api/admin/payment-gateways/:gatewayName/status - Enable / Disable / Maintenance mode
router.patch("/admin/payment-gateways/:gatewayName/status", authAdmin, async (req, res) => {
  const gatewayName = req.params.gatewayName.toLowerCase();
  const { status, is_enabled } = req.body;

  try {
    const [existing] = await sql`
      SELECT * FROM payment_gateway_configs WHERE gateway_name = ${gatewayName}
    `;

    if (!existing) {
      return res.status(404).json({ success: false, message: "Gateway not found" });
    }

    const updates = {};
    if (status !== undefined) updates.status = status;
    if (status === "active") updates.is_enabled = true;
    if (status === "inactive") updates.is_enabled = false;
    if (is_enabled !== undefined) updates.is_enabled = is_enabled;
    updates.updated_at = new Date();

    const [updated] = await sql`
      UPDATE payment_gateway_configs SET ${sql(updates)}
      WHERE gateway_name = ${gatewayName}
      RETURNING *
    `;

    await logGatewayAudit(req.admin.admin_id, gatewayName, "TOGGLE_STATUS", maskConfig(existing), maskConfig(updated), req);

    return res.json({ success: true, message: "Status updated successfully.", data: maskConfig(updated) });
  } catch (e) {
    console.error("Toggle status failed:", e);
    return err(res, "Failed to update status.");
  }
});

// PATCH /api/admin/payment-gateways/default - Set default gateway
router.patch("/admin/payment-gateways/default", authAdmin, async (req, res) => {
  const { gateway_name } = req.body;
  if (!gateway_name) {
    return res.status(400).json({ success: false, message: "gateway_name is required" });
  }

  try {
    const [target] = await sql`
      SELECT * FROM payment_gateway_configs WHERE gateway_name = ${gateway_name.toLowerCase()}
    `;

    if (!target) {
      return res.status(404).json({ success: false, message: "Gateway not found" });
    }

    await sql.begin(async (tx) => {
      await tx`
        UPDATE payment_gateway_configs SET is_default = false 
        WHERE gateway_name != ${gateway_name.toLowerCase()}
      `;
      await tx`
        UPDATE payment_gateway_configs SET is_default = true 
        WHERE gateway_name = ${gateway_name.toLowerCase()}
      `;
    });

    await logGatewayAudit(req.admin.admin_id, gateway_name, "SET_DEFAULT", null, { is_default: true }, req);

    return res.json({ success: true, message: `Default gateway set to ${gateway_name}.` });
  } catch (e) {
    console.error("Set default failed:", e);
    return err(res, "Failed to set default gateway.");
  }
});

// PATCH /api/admin/payment-gateways/user-selection - Enable or disable user gateway selection
router.patch("/admin/payment-gateways/user-selection", authAdmin, async (req, res) => {
  const { allow_user_selection } = req.body;
  if (allow_user_selection === undefined) {
    return res.status(400).json({ success: false, message: "allow_user_selection is required." });
  }

  try {
    await sql`
      UPDATE payment_gateway_configs SET allow_user_selection = ${allow_user_selection}
    `;

    await logGatewayAudit(req.admin.admin_id, "all", "TOGGLE_USER_SELECTION", null, { allow_user_selection }, req);

    return res.json({ success: true, message: `User gateway selection ${allow_user_selection ? "enabled" : "disabled"}.` });
  } catch (e) {
    console.error("User selection toggle failed:", e);
    return err(res, "Failed to update user selection setting.");
  }
});

// PATCH /api/admin/payment-gateways/fallback - Enable or disable fallback gateway logic
router.patch("/admin/payment-gateways/fallback", authAdmin, async (req, res) => {
  const { fallback_enabled } = req.body;
  if (fallback_enabled === undefined) {
    return res.status(400).json({ success: false, message: "fallback_enabled is required." });
  }

  try {
    await sql`
      UPDATE payment_gateway_configs SET fallback_enabled = ${fallback_enabled}
    `;

    await logGatewayAudit(req.admin.admin_id, "all", "TOGGLE_FALLBACK", null, { fallback_enabled }, req);

    return res.json({ success: true, message: `Fallback gateway logic ${fallback_enabled ? "enabled" : "disabled"}.` });
  } catch (e) {
    console.error("Fallback toggle failed:", e);
    return err(res, "Failed to update fallback setting.");
  }
});

// GET /api/admin/payment-gateways/audit-logs - Show gateway configuration change history
router.get("/admin/payment-gateways/audit-logs", authAdmin, async (req, res) => {
  try {
    const logs = await sql`
      SELECT l.*, a.full_name as admin_name 
      FROM payment_gateway_audit_logs l
      LEFT JOIN admin_users a ON l.admin_id = a.admin_id
      ORDER BY l.created_at DESC
      LIMIT 100
    `;
    return ok(res, logs, "Audit logs fetched successfully.");
  } catch (e) {
    console.error("Load audit logs failed:", e);
    return err(res, "Failed to load audit logs.");
  }
});

// ─── ADMIN REFUND API ─────────────────────────────────────────

// POST /api/payment/refund - Request a refund
router.post("/payment/refund", authAdmin, paymentRateLimiter, validateBody(refundSchema), async (req, res) => {
  const { order_id, amount, reason } = req.body;

  try {
    const [tx] = await sql`
      SELECT * FROM payment_transactions WHERE order_id = ${order_id}
    `;

    if (!tx) {
      return res.status(404).json({ success: false, message: "Transaction not found." });
    }

    if (tx.payment_status !== "success" && tx.payment_status !== "captured") {
      return res.status(400).json({ success: false, message: "Cannot refund a payment that was not successful." });
    }

    const refundAmount = amount ? Number(amount) : Number(tx.amount);
    if (refundAmount <= 0 || refundAmount > Number(tx.amount)) {
      return res.status(400).json({ success: false, message: "Invalid refund amount requested." });
    }

    const gateway = await GatewayFactory.getGatewayInstance(tx.gateway_name);

    // Call refund on gateway, passing gateway payment ID (or order ID as fallback)
    const result = await gateway.refundPayment(tx.gateway_payment_id || tx.order_id, refundAmount, reason);

    await sql`
      UPDATE payment_transactions SET
        payment_status = 'refunded',
        gateway_response = ${JSON.stringify({ ...tx.gateway_response, refund_response: result.raw_response })},
        updated_at = NOW()
      WHERE order_id = ${order_id}
    `;

    await logPaymentEvent(order_id, tx.gateway_name, "REFUND_SUCCESS", req.body, result, req);
    await logGatewayAudit(req.admin.admin_id, tx.gateway_name, "PAYMENT_REFUND", { amount: tx.amount }, { refundAmount, reason }, req);

    return ok(res, result, "Refund processed successfully.");
  } catch (error) {
    console.error("Refund request failed:", error);
    await logPaymentEvent(order_id, "unknown", "REFUND_FAILURE", req.body, { error: error.message }, req);
    return res.status(500).json({ success: false, message: error.message || "Failed to process refund." });
  }
});

export default router;
