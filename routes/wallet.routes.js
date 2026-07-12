import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import sql from "../db.js";
import GatewayFactory from "../payment/GatewayFactory.js";
import { z } from "zod";

const router = express.Router();

// ─── HELPERS ──────────────────────────────────────────────────
const ok = (res, data, msg = "Success", status = 200) =>
  res.status(status).json({ success: true, message: msg, data });

const err = (res, msg = "Server error", status = 500) =>
  res.status(status).json({ success: false, message: msg });

const getWalletRole = (user = {}) => {
  const role = user.user_type || user.role;
  return role === "Associate" ? "Associate" : "Customer";
};

const isAdminPrincipal = (principal = {}) => {
  const adminRoles = new Set(["SuperAdmin", "FinanceManager", "SiteManager", "SupportStaff", "Admin", "admin", "super_admin"]);
  return Boolean(principal.admin_id || adminRoles.has(principal.role));
};

// ─── AUTH MIDDLEWARES ──────────────────────────────────────────
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
    if (!isAdminPrincipal(req.admin)) {
      return res.status(403).json({ success: false, message: "Forbidden - Admin access required" });
    }
    next();
  } catch (err) {
    try {
      req.admin = jwt.verify(token, process.env.JWT_SECRET);
      if (!isAdminPrincipal(req.admin)) {
        return res.status(403).json({ success: false, message: "Forbidden - Admin access required" });
      }
      next();
    } catch {
      return res.status(401).json({ success: false, message: "Invalid or expired admin token" });
    }
  }
}

// ─── WALLET UTILS ─────────────────────────────────────────────
async function getOrCreateWallet(userId, userRole, txConnection = sql) {
  const [existing] = await txConnection`
    SELECT * FROM user_wallets WHERE user_id = ${userId}
  `;
  if (existing) return existing;

  const [newWallet] = await txConnection`
    INSERT INTO user_wallets (user_id, user_role, available_balance, pending_withdrawal_balance, total_added_fund, total_withdrawn, total_commission)
    VALUES (${userId}, ${userRole}, 0.00, 0.00, 0.00, 0.00, 0.00)
    RETURNING *
  `;

  // Log audit log for wallet creation
  await logWalletAudit(userId, null, "CREATE_WALLET", {}, newWallet, txConnection);

  return newWallet;
}

async function logWalletAudit(userId, adminId, actionType, oldValue, newValue, txConnection = sql) {
  try {
    await txConnection`
      INSERT INTO wallet_audit_logs (user_id, admin_id, action_type, old_value, new_value)
      VALUES (${userId || null}, ${adminId || null}, ${actionType}, ${JSON.stringify(oldValue)}, ${JSON.stringify(newValue)})
    `;
  } catch (e) {
    console.error("[logWalletAudit Error]", e.message);
  }
}

// ─── VALIDATIONS ──────────────────────────────────────────────
const addFundSchema = z.object({
  amount: z.union([z.number(), z.string()]).transform((val) => Number(val)).refine((val) => val > 0, "Amount must be greater than 0"),
  gateway_name: z.string().min(1, "Payment gateway is required"),
});

const verifyFundSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  gateway_name: z.string().min(1, "gateway_name is required"),
  // Razorpay-specific fields:
  razorpay_order_id: z.string().optional(),
  razorpay_payment_id: z.string().optional(),
  razorpay_signature: z.string().optional(),
});

const cancelFundSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
});

const withdrawRequestSchema = z.object({
  amount: z.union([z.number(), z.string()]).transform((val) => Number(val)).refine((val) => val > 0, "Amount must be greater than 0"),
  bank_account_holder_name: z.string().trim().min(1, "Bank account holder name is required"),
  bank_account_number: z.string().trim().regex(/^[0-9]{6,20}$/, "Bank account number must be 6 to 20 digits"),
  ifsc_code: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Valid IFSC code is required"),
  bank_name: z.string().trim().min(1, "Bank name is required"),
  upi_id: z.string().trim().regex(/^[\w.-]+@[\w.-]+$/, "Valid UPI ID is required").optional().or(z.literal("")).nullable(),
  remarks: z.string().optional().nullable(),
});

const validateBody = (schema) => (req, res, next) => {
  try {
    req.body = schema.parse(req.body);
    next();
  } catch (e) {
    const errorMsg = e.errors ? e.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(', ') : e.message;
    return res.status(400).json({ success: false, message: `Validation error: ${errorMsg}` });
  }
};

// ─── USER APIS ────────────────────────────────────────────────

// GET /api/wallet/balance - Return logged-in user wallet balance
router.get("/wallet/balance", authUser, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const role = getWalletRole(req.user);
    const wallet = await getOrCreateWallet(userId, role);
    return ok(res, wallet, "Wallet balance retrieved successfully.");
  } catch (e) {
    console.error("[GET /wallet/balance Error]", e);
    return err(res, "Failed to retrieve wallet balance.");
  }
});

// GET /api/wallet/transactions - Return logged-in user wallet transactions
router.get("/wallet/transactions", authUser, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const transactions = await sql`
      SELECT * FROM wallet_transactions
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;
    return ok(res, transactions, "Wallet transactions loaded.");
  } catch (e) {
    console.error("[GET /wallet/transactions Error]", e);
    return err(res, "Failed to retrieve wallet transactions.");
  }
});

// POST /api/wallet/add-fund/initiate - Create payment order
router.post("/wallet/add-fund/initiate", authUser, validateBody(addFundSchema), async (req, res) => {
  const { amount, gateway_name } = req.body;
  const userId = req.user.user_id;
  const role = getWalletRole(req.user);

  try {
    // Generate a unique order ID for wallet credit
    const order_id = `WAL-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    // Get user details for gateway order creation
    const [user] = await sql`
      SELECT full_name, email, mobile_no FROM users WHERE user_id = ${userId}
    `;

    const customer_name = user?.full_name || "User";
    const customer_email = user?.email || "wallet@example.com";
    const customer_mobile = user?.mobile_no || "9999999999";

    // Resolve gateway strategy
    const gatewayInstance = await GatewayFactory.resolveGateway(gateway_name);
    const selectedGatewayName = gatewayInstance.config.gateway_name;
    const minAmount = role === "Associate"
      ? Number(gatewayInstance.config.min_associate_fund_amount ?? 100)
      : Number(gatewayInstance.config.min_customer_fund_amount ?? 100);

    if (amount < minAmount) {
      return res.status(400).json({
        success: false,
        message: `Minimum add fund amount for ${role}s is INR ${minAmount.toFixed(2)}.`,
      });
    }

    const customerDetails = {
      name: customer_name,
      email: customer_email,
      phone: customer_mobile,
      customer_id: userId.toString(),
    };

    // Construct callback url
    const callbackUrl = gatewayInstance.config.callback_url || `${req.protocol}://${req.get("host")}/api/wallet/add-fund/verify-callback`;

    // Create order on gateway
    const r = await gatewayInstance.createOrder(order_id, amount, customerDetails, callbackUrl);

    // Save pending transaction inside database
    await sql.begin(async (tx) => {
      const wallet = await getOrCreateWallet(userId, role, tx);

      await tx`
        INSERT INTO wallet_transactions (
          wallet_id, user_id, user_role, transaction_type, source, amount,
          balance_before, balance_after, payment_gateway, payment_order_id,
          status, remarks, gateway_response
        ) VALUES (
          ${wallet.id}, ${userId}, ${role}, 'credit', 'Add Fund', ${amount},
          ${wallet.available_balance}, ${wallet.available_balance}, ${selectedGatewayName}, ${order_id},
          'pending', ${`Adding fund using ${selectedGatewayName}`}, ${JSON.stringify(r)}
        )
      `;
    });

    return ok(res, {
      order_id,
      gateway_name: selectedGatewayName,
      gateway_order_id: r.gateway_order_id,
      checkout_details: r.checkout_details || r,
    }, "Wallet payment order initiated.");
  } catch (e) {
    console.error("[POST /wallet/add-fund/initiate Error]", e);
    return err(res, e.message || "Failed to initiate wallet payment.");
  }
});

// POST /api/wallet/add-fund/verify - Verify payment and credit wallet
router.post("/wallet/add-fund/verify", authUser, validateBody(verifyFundSchema), async (req, res) => {
  const { order_id, gateway_name } = req.body;
  const userId = req.user.user_id;

  try {
    // Find the pending transaction in DB
    const [txRecord] = await sql`
      SELECT * FROM wallet_transactions WHERE payment_order_id = ${order_id} AND user_id = ${userId}
    `;

    if (!txRecord) {
      return res.status(404).json({ success: false, message: "Transaction record not found." });
    }

    if (txRecord.status === "success") {
      // Already credited to prevent double-credit
      const wallet = await getOrCreateWallet(userId, txRecord.user_role);
      return ok(res, { balance: wallet.available_balance }, "Payment already successfully verified.");
    }

    if (String(txRecord.payment_gateway || "").toLowerCase() !== String(gateway_name || "").toLowerCase()) {
      return res.status(400).json({ success: false, message: "Payment gateway does not match the initiated transaction." });
    }

    // Call payment gateway to verify
    const gateway = await GatewayFactory.getGatewayInstance(gateway_name);
    
    // Construct request body/query for verification
    const verificationResult = await gateway.verifyPayment(order_id, {}, req.body);

    if (verificationResult.status === "success") {
      const expectedAmount = Number(txRecord.amount);
      const verifiedAmount = Number(verificationResult.amount);
      if (!Number.isFinite(verifiedAmount) || Math.abs(verifiedAmount - expectedAmount) > 0.01) {
        await sql`
          UPDATE wallet_transactions SET
            status = 'failed',
            remarks = ${`Payment amount mismatch. Expected INR ${expectedAmount}, received INR ${verificationResult.amount}`},
            gateway_response = ${JSON.stringify(verificationResult.raw_response || verificationResult)},
            updated_at = NOW()
          WHERE id = ${txRecord.id}
        `;
        return res.status(400).json({ success: false, message: "Payment amount mismatch. Wallet was not credited." });
      }

      let finalWallet;
      // Perform wallet credit in atomic DB transaction with Row-Level Locking
      await sql.begin(async (tx) => {
        // Double-check inside transaction lock
        const [lockedTx] = await tx`
          SELECT * FROM wallet_transactions WHERE id = ${txRecord.id} FOR UPDATE
        `;

        if (lockedTx.status === "success") {
          return;
        }

        // Lock wallet for update
        const [wallet] = await tx`
          SELECT * FROM user_wallets WHERE id = ${txRecord.wallet_id} FOR UPDATE
        `;

        const amount = Number(txRecord.amount);
        const oldAvailable = Number(wallet.available_balance);
        const newAvailable = oldAvailable + amount;
        const oldAdded = Number(wallet.total_added_fund);
        const newAdded = oldAdded + amount;

        // Update Wallet Balance
        [finalWallet] = await tx`
          UPDATE user_wallets SET
            available_balance = ${newAvailable},
            total_added_fund = ${newAdded},
            updated_at = NOW()
          WHERE id = ${wallet.id}
          RETURNING *
        `;

        // Update Transaction Log
        await tx`
          UPDATE wallet_transactions SET
            status = 'success',
            balance_before = ${oldAvailable},
            balance_after = ${newAvailable},
            payment_transaction_id = ${verificationResult.gateway_payment_id || null},
            gateway_response = ${JSON.stringify(verificationResult.raw_response || verificationResult)},
            updated_at = NOW()
          WHERE id = ${txRecord.id}
        `;

        // Audit log
        await logWalletAudit(userId, null, "CREDIT_ADD_FUND", wallet, finalWallet, tx);
      });

      const updatedWallet = finalWallet || await getOrCreateWallet(userId, txRecord.user_role);
      return ok(res, { balance: updatedWallet.available_balance }, "Wallet fund added successfully!");
    } else {
      // Payment verification failed
      await sql`
        UPDATE wallet_transactions SET
          status = 'failed',
          remarks = ${verificationResult.message || "Payment verification failed"},
          updated_at = NOW()
        WHERE id = ${txRecord.id}
      `;
      return res.status(400).json({ success: false, message: "Payment verification failed." });
    }
  } catch (e) {
    console.error("[POST /wallet/add-fund/verify Error]", e);
    // Update status to failed
    await sql`
      UPDATE wallet_transactions SET
        status = 'failed',
        remarks = ${e.message || "Verification system error"},
        updated_at = NOW()
      WHERE payment_order_id = ${order_id} AND status = 'pending'
    `.catch(() => {});
    return res.status(500).json({ success: false, message: e.message || "Verification failed." });
  }
});

// GET/POST /api/wallet/add-fund/verify-callback - Handle hosted checkout redirect callbacks
router.all("/wallet/add-fund/verify-callback", async (req, res) => {
  const callbackPayload = req.method === "GET" ? req.query : req.body;
  const order_id = callbackPayload.order_id || callbackPayload.txnid;

  if (!order_id) {
    return res.status(400).send("Missing order_id in callback");
  }

  let txRecord;
  try {
    [txRecord] = await sql`
      SELECT * FROM wallet_transactions WHERE payment_order_id = ${order_id}
    `;

    if (!txRecord) {
      return res.status(404).send("Transaction record not found");
    }

    const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:4200";
    const panelPath = txRecord.user_role.toLowerCase() === "associate" ? "associate" : "user";

    if (txRecord.status === "success") {
      return res.redirect(`${FRONTEND_URL}/${panelPath}/wallet?payment=success&order_id=${order_id}`);
    }

    // Call payment gateway to verify
    const gateway = await GatewayFactory.getGatewayInstance(txRecord.payment_gateway);
    const verificationResult = await gateway.verifyPayment(order_id, req.query, req.body);

    if (verificationResult.status === "success") {
      const expectedAmount = Number(txRecord.amount);
      const verifiedAmount = Number(verificationResult.amount);
      if (!Number.isFinite(verifiedAmount) || Math.abs(verifiedAmount - expectedAmount) > 0.01) {
        await sql`
          UPDATE wallet_transactions SET
            status = 'failed',
            remarks = ${`Payment amount mismatch. Expected INR ${expectedAmount}, received INR ${verificationResult.amount}`},
            gateway_response = ${JSON.stringify(verificationResult.raw_response || verificationResult)},
            updated_at = NOW()
          WHERE id = ${txRecord.id}
        `;
        return res.redirect(`${FRONTEND_URL}/${panelPath}/wallet?payment=failed&order_id=${order_id}&reason=${encodeURIComponent("Payment amount mismatch")}`);
      }

      let finalWallet;
      await sql.begin(async (tx) => {
        // Double-check lock
        const [lockedTx] = await tx`
          SELECT * FROM wallet_transactions WHERE id = ${txRecord.id} FOR UPDATE
        `;

        if (lockedTx.status === "success") return;

        const [wallet] = await tx`
          SELECT * FROM user_wallets WHERE id = ${txRecord.wallet_id} FOR UPDATE
        `;

        const amount = Number(txRecord.amount);
        const oldAvailable = Number(wallet.available_balance);
        const newAvailable = oldAvailable + amount;
        const oldAdded = Number(wallet.total_added_fund);
        const newAdded = oldAdded + amount;

        [finalWallet] = await tx`
          UPDATE user_wallets SET
            available_balance = ${newAvailable},
            total_added_fund = ${newAdded},
            updated_at = NOW()
          WHERE id = ${wallet.id}
          RETURNING *
        `;

        await tx`
          UPDATE wallet_transactions SET
            status = 'success',
            balance_before = ${oldAvailable},
            balance_after = ${newAvailable},
            payment_transaction_id = ${verificationResult.gateway_payment_id || null},
            gateway_response = ${JSON.stringify(verificationResult.raw_response || verificationResult)},
            updated_at = NOW()
          WHERE id = ${txRecord.id}
        `;

        await logWalletAudit(txRecord.user_id, null, "CREDIT_ADD_FUND", wallet, finalWallet, tx);
      });

      return res.redirect(`${FRONTEND_URL}/${panelPath}/wallet?payment=success&order_id=${order_id}`);
    } else {
      await sql`
        UPDATE wallet_transactions SET
          status = 'failed',
          remarks = ${verificationResult.message || "Payment callback report failed"},
          updated_at = NOW()
        WHERE id = ${txRecord.id}
      `;
      return res.redirect(`${FRONTEND_URL}/${panelPath}/wallet?payment=failed&order_id=${order_id}&reason=Payment failed`);
    }
  } catch (e) {
    console.error("[GET /wallet/add-fund/verify-callback Error]", e);
    await sql`
      UPDATE wallet_transactions SET
        status = 'failed',
        remarks = ${e.message || "Callback verification error"},
        updated_at = NOW()
      WHERE payment_order_id = ${order_id} AND status = 'pending'
    `.catch(() => {});
    const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:4200";
    const panelPath = txRecord?.user_role?.toLowerCase() === "associate" ? "associate" : "user";
    return res.redirect(`${FRONTEND_URL}/${panelPath}/wallet?payment=failed&order_id=${order_id}&reason=${encodeURIComponent(e.message)}`);
  }
});

// POST /api/wallet/add-fund/cancel - Mark a pending add-fund attempt cancelled
router.post("/wallet/add-fund/cancel", authUser, validateBody(cancelFundSchema), async (req, res) => {
  const userId = req.user.user_id;
  const { order_id } = req.body;

  try {
    const [updated] = await sql`
      UPDATE wallet_transactions SET
        status = 'cancelled',
        remarks = 'Payment cancelled by user',
        updated_at = NOW()
      WHERE payment_order_id = ${order_id}
        AND user_id = ${userId}
        AND status = 'pending'
      RETURNING id
    `;

    if (!updated) {
      return res.status(404).json({ success: false, message: "Pending transaction not found." });
    }

    return ok(res, null, "Payment attempt cancelled.");
  } catch (e) {
    console.error("[POST /wallet/add-fund/cancel Error]", e);
    return err(res, "Failed to cancel payment attempt.");
  }
});

// POST /api/wallet/withdraw-request - Create a withdrawal request
router.post("/wallet/withdraw-request", authUser, validateBody(withdrawRequestSchema), async (req, res) => {
  const { amount, bank_account_holder_name, bank_account_number, ifsc_code, bank_name, upi_id, remarks } = req.body;
  const userId = req.user.user_id;
  const role = getWalletRole(req.user);

  try {
    // Configurable Minimum withdrawal limit (e.g. INR 100)
    const MIN_WITHDRAWAL = Number(process.env.MIN_WALLET_WITHDRAWAL || 100.00);
    if (amount < MIN_WITHDRAWAL) {
      return res.status(400).json({ success: false, message: `Minimum withdrawal amount is INR ${MIN_WITHDRAWAL.toFixed(2)}.` });
    }

    let withdrawalId;
    await sql.begin(async (tx) => {
      // 1. Lock wallet for update
      const wallet = await getOrCreateWallet(userId, role, tx);
      const [lockedWallet] = await tx`
        SELECT * FROM user_wallets WHERE id = ${wallet.id} FOR UPDATE
      `;

      // 2. Validate Available Balance
      const available = Number(lockedWallet.available_balance);
      if (amount > available) {
        throw new Error("Insufficient available balance for withdrawal.");
      }

      // 3. Check duplicate pending request
      const [pendingRequest] = await tx`
        SELECT id FROM withdrawal_requests 
        WHERE user_id = ${userId} AND status = 'pending'
        LIMIT 1
      `;
      if (pendingRequest) {
        throw new Error("You already have a pending withdrawal request.");
      }

      // 4. Create Withdrawal Request
      const [request] = await tx`
        INSERT INTO withdrawal_requests (
          user_id, user_role, wallet_id, amount,
          bank_account_holder_name, bank_account_number, ifsc_code, bank_name, upi_id,
          status, admin_remarks
        ) VALUES (
          ${userId}, ${role}, ${lockedWallet.id}, ${amount},
          ${bank_account_holder_name}, ${bank_account_number}, ${ifsc_code}, ${bank_name}, ${upi_id || null},
          'pending', ${remarks || null}
        ) RETURNING id
      `;

      withdrawalId = request.id;

      // 5. Deduct from available balance and add to pending withdrawal balance
      const newAvailable = available - amount;
      const newPendingWithdrawal = Number(lockedWallet.pending_withdrawal_balance) + amount;

      const [updatedWallet] = await tx`
        UPDATE user_wallets SET
          available_balance = ${newAvailable},
          pending_withdrawal_balance = ${newPendingWithdrawal},
          updated_at = NOW()
        WHERE id = ${lockedWallet.id}
        RETURNING *
      `;

      // 6. Create Debit transaction in pending state
      await tx`
        INSERT INTO wallet_transactions (
          wallet_id, user_id, user_role, transaction_type, source, amount,
          balance_before, balance_after, status, remarks, withdrawal_request_id
        ) VALUES (
          ${lockedWallet.id}, ${userId}, ${role}, 'debit', 'Withdrawal', ${amount},
          ${available}, ${newAvailable}, 'pending', ${`Withdrawal request submitted for INR ${amount}`}, ${withdrawalId}
        )
      `;

      // Log audit
      await logWalletAudit(userId, null, "INITIATE_WITHDRAWAL", lockedWallet, updatedWallet, tx);
    });

    return ok(res, { withdrawal_id: withdrawalId }, "Withdrawal request submitted successfully.");
  } catch (e) {
    console.error("[POST /wallet/withdraw-request Error]", e);
    return res.status(400).json({ success: false, message: e.message || "Failed to submit withdrawal request." });
  }
});

// GET /api/wallet/withdraw-requests - Return logged-in user withdrawal requests
router.get("/wallet/withdraw-requests", authUser, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const requests = await sql`
      SELECT * FROM withdrawal_requests
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;
    return ok(res, requests, "Withdrawal requests loaded.");
  } catch (e) {
    console.error("[GET /wallet/withdraw-requests Error]", e);
    return err(res, "Failed to load withdrawal requests.");
  }
});

// ─── ADMIN APIS ───────────────────────────────────────────────

// GET /api/admin/withdrawal-requests - Return all withdrawal requests with filters
router.get("/admin/withdrawal-requests", authAdmin, async (req, res) => {
  try {
    const { status, user_role, search, start_date, end_date } = req.query;

    let query = sql`
      SELECT wr.*, u.full_name as user_name, u.email as user_email, u.mobile_no as user_mobile
      FROM withdrawal_requests wr
      JOIN users u ON wr.user_id = u.user_id
      WHERE 1=1
    `;

    if (status) {
      query = sql`${query} AND wr.status = ${status}`;
    }
    if (user_role) {
      query = sql`${query} AND wr.user_role = ${user_role}`;
    }
    if (search) {
      const searchWild = `%${search}%`;
      query = sql`${query} AND (u.full_name ILIKE ${searchWild} OR u.email ILIKE ${searchWild} OR u.mobile_no ILIKE ${searchWild})`;
    }
    if (start_date) {
      query = sql`${query} AND wr.created_at >= ${start_date}`;
    }
    if (end_date) {
      query = sql`${query} AND wr.created_at <= ${end_date}`;
    }

    query = sql`${query} ORDER BY wr.created_at DESC`;

    const requests = await query;
    return ok(res, requests, "Withdrawal requests filtered and loaded.");
  } catch (e) {
    console.error("[GET /admin/withdrawal-requests Error]", e);
    return err(res, "Failed to load withdrawal requests for admin.");
  }
});

// GET /api/admin/withdrawal-requests/:id - Return withdrawal request details
router.get("/admin/withdrawal-requests/:id", authAdmin, async (req, res) => {
  try {
    const [request] = await sql`
      SELECT wr.*, u.full_name as user_name, u.email as user_email, u.mobile_no as user_mobile
      FROM withdrawal_requests wr
      JOIN users u ON wr.user_id = u.user_id
      WHERE wr.id = ${req.params.id}
    `;

    if (!request) {
      return res.status(404).json({ success: false, message: "Withdrawal request not found." });
    }

    return ok(res, request, "Withdrawal request details loaded.");
  } catch (e) {
    console.error("[GET /admin/withdrawal-requests/:id Error]", e);
    return err(res, "Failed to load withdrawal request details.");
  }
});

// PATCH /api/admin/withdrawal-requests/:id/approve - Approve request
router.patch("/admin/withdrawal-requests/:id/approve", authAdmin, async (req, res) => {
  const adminId = req.admin.admin_id || req.admin.id;
  const { remarks } = req.body;

  try {
    await sql.begin(async (tx) => {
      // 1. Lock request for update
      const [request] = await tx`
        SELECT * FROM withdrawal_requests WHERE id = ${req.params.id} FOR UPDATE
      `;

      if (!request) {
        throw new Error("Withdrawal request not found.");
      }

      if (request.status !== "pending") {
        throw new Error(`Cannot approve request. Current status: ${request.status}`);
      }

      // 2. Change status to approved
      await tx`
        UPDATE withdrawal_requests SET
          status = 'approved',
          admin_remarks = ${remarks || null},
          approved_by = ${adminId},
          approved_at = NOW(),
          updated_at = NOW()
        WHERE id = ${request.id}
      `;

      // Log audit
      await logWalletAudit(request.user_id, adminId, "APPROVE_WITHDRAWAL", request, { ...request, status: "approved" }, tx);
    });

    return ok(res, null, "Withdrawal request approved successfully.");
  } catch (e) {
    console.error("[PATCH /admin/withdrawal-requests/:id/approve Error]", e);
    return res.status(400).json({ success: false, message: e.message || "Failed to approve request." });
  }
});

// PATCH /api/admin/withdrawal-requests/:id/reject - Reject request with reason
router.patch("/admin/withdrawal-requests/:id/reject", authAdmin, async (req, res) => {
  const adminId = req.admin.admin_id || req.admin.id;
  const { rejection_reason } = req.body;

  if (!rejection_reason) {
    return res.status(400).json({ success: false, message: "Rejection reason is required." });
  }

  try {
    await sql.begin(async (tx) => {
      // 1. Lock request for update
      const [request] = await tx`
        SELECT * FROM withdrawal_requests WHERE id = ${req.params.id} FOR UPDATE
      `;

      if (!request) {
        throw new Error("Withdrawal request not found.");
      }

      if (request.status !== "pending" && request.status !== "approved") {
        throw new Error(`Cannot reject request. Current status: ${request.status}`);
      }

      // 2. Lock user wallet
      const [wallet] = await tx`
        SELECT * FROM user_wallets WHERE id = ${request.wallet_id} FOR UPDATE
      `;

      const amount = Number(request.amount);
      const oldAvailable = Number(wallet.available_balance);
      const oldPending = Number(wallet.pending_withdrawal_balance);

      // 3. Return held amount to available balance
      const newAvailable = oldAvailable + amount;
      const newPending = Math.max(0, oldPending - amount);

      const [updatedWallet] = await tx`
        UPDATE user_wallets SET
          available_balance = ${newAvailable},
          pending_withdrawal_balance = ${newPending},
          updated_at = NOW()
        WHERE id = ${wallet.id}
        RETURNING *
      `;

      // 4. Update request status to rejected
      await tx`
        UPDATE withdrawal_requests SET
          status = 'rejected',
          rejection_reason = ${rejection_reason},
          updated_at = NOW()
        WHERE id = ${request.id}
      `;

      // 5. Update transaction record to failed / cancelled
      await tx`
        UPDATE wallet_transactions SET
          status = 'failed',
          remarks = ${`Rejected by admin. Reason: ${rejection_reason}`},
          balance_before = ${oldAvailable},
          balance_after = ${newAvailable},
          updated_at = NOW()
        WHERE withdrawal_request_id = ${request.id}
      `;

      // Log audit
      await logWalletAudit(request.user_id, adminId, "REJECT_WITHDRAWAL", request, { ...request, status: "rejected", rejection_reason }, tx);
    });

    return ok(res, null, "Withdrawal request rejected and balance returned.");
  } catch (e) {
    console.error("[PATCH /admin/withdrawal-requests/:id/reject Error]", e);
    return res.status(400).json({ success: false, message: e.message || "Failed to reject request." });
  }
});

// PATCH /api/admin/withdrawal-requests/:id/release - Mark fund as released (Payout success)
router.patch("/admin/withdrawal-requests/:id/release", authAdmin, async (req, res) => {
  const adminId = req.admin.admin_id || req.admin.id;
  const { payout_reference_id, remarks } = req.body;

  try {
    await sql.begin(async (tx) => {
      // 1. Lock request
      const [request] = await tx`
        SELECT * FROM withdrawal_requests WHERE id = ${req.params.id} FOR UPDATE
      `;

      if (!request) {
        throw new Error("Withdrawal request not found.");
      }

      if (request.status !== "approved" && request.status !== "pending") {
        throw new Error(`Cannot release funds for request. Current status: ${request.status}`);
      }

      // 2. Lock user wallet
      const [wallet] = await tx`
        SELECT * FROM user_wallets WHERE id = ${request.wallet_id} FOR UPDATE
      `;

      const amount = Number(request.amount);
      const oldPending = Number(wallet.pending_withdrawal_balance);
      const oldWithdrawn = Number(wallet.total_withdrawn);

      // 3. Deduct from pending withdrawal, add to total withdrawn
      const newPending = Math.max(0, oldPending - amount);
      const newWithdrawn = oldWithdrawn + amount;

      const [updatedWallet] = await tx`
        UPDATE user_wallets SET
          pending_withdrawal_balance = ${newPending},
          total_withdrawn = ${newWithdrawn},
          updated_at = NOW()
        WHERE id = ${wallet.id}
        RETURNING *
      `;

      // 4. Update request status to released
      await tx`
        UPDATE withdrawal_requests SET
          status = 'released',
          released_by = ${adminId},
          released_at = NOW(),
          payout_reference_id = ${payout_reference_id || `REF-MAN-${Date.now()}`},
          admin_remarks = ${remarks || request.admin_remarks},
          updated_at = NOW()
        WHERE id = ${request.id}
      `;

      // 5. Update transaction record to success (debit completed)
      await tx`
        UPDATE wallet_transactions SET
          status = 'success',
          remarks = ${remarks || `Fund released with Reference ID: ${payout_reference_id}`},
          updated_at = NOW()
        WHERE withdrawal_request_id = ${request.id}
      `;

      // Log audit
      await logWalletAudit(request.user_id, adminId, "RELEASE_WITHDRAWAL", request, { ...request, status: "released" }, tx);
    });

    return ok(res, null, "Withdrawal request funds released successfully.");
  } catch (e) {
    console.error("[PATCH /admin/withdrawal-requests/:id/release Error]", e);
    return res.status(400).json({ success: false, message: e.message || "Failed to release funds." });
  }
});

// PATCH /api/admin/withdrawal-requests/:id/failed - Mark payout as failed
router.patch("/admin/withdrawal-requests/:id/failed", authAdmin, async (req, res) => {
  const adminId = req.admin.admin_id || req.admin.id;
  const { remarks } = req.body;

  try {
    await sql.begin(async (tx) => {
      // 1. Lock request
      const [request] = await tx`
        SELECT * FROM withdrawal_requests WHERE id = ${req.params.id} FOR UPDATE
      `;

      if (!request) {
        throw new Error("Withdrawal request not found.");
      }

      if (request.status !== "approved" && request.status !== "pending") {
        throw new Error(`Cannot mark request as failed. Current status: ${request.status}`);
      }

      // 2. Lock user wallet
      const [wallet] = await tx`
        SELECT * FROM user_wallets WHERE id = ${request.wallet_id} FOR UPDATE
      `;

      const amount = Number(request.amount);
      const oldAvailable = Number(wallet.available_balance);
      const oldPending = Number(wallet.pending_withdrawal_balance);

      // Return amount to available balance
      const newAvailable = oldAvailable + amount;
      const newPending = Math.max(0, oldPending - amount);

      const [updatedWallet] = await tx`
        UPDATE user_wallets SET
          available_balance = ${newAvailable},
          pending_withdrawal_balance = ${newPending},
          updated_at = NOW()
        WHERE id = ${wallet.id}
        RETURNING *
      `;

      // 3. Update request status to failed
      await tx`
        UPDATE withdrawal_requests SET
          status = 'failed',
          admin_remarks = ${remarks || "Payout processing failed"},
          updated_at = NOW()
        WHERE id = ${request.id}
      `;

      // 4. Update transaction record to failed
      await tx`
        UPDATE wallet_transactions SET
          status = 'failed',
          remarks = ${remarks || "Payout processing failed. Amount refunded to wallet."},
          balance_before = ${oldAvailable},
          balance_after = ${newAvailable},
          updated_at = NOW()
        WHERE withdrawal_request_id = ${request.id}
      `;

      // Log audit
      await logWalletAudit(request.user_id, adminId, "WITHDRAWAL_FAILED", request, { ...request, status: "failed" }, tx);
    });

    return ok(res, null, "Withdrawal marked as failed. Balance refunded.");
  } catch (e) {
    console.error("[PATCH /admin/withdrawal-requests/:id/failed Error]", e);
    return res.status(400).json({ success: false, message: e.message || "Failed to mark as failed." });
  }
});

export default router;
