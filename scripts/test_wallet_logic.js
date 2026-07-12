import sql from "../db.js";
import crypto from "crypto";

async function runTests() {
  console.log("=== STARTING WALLET LOGIC TRANSACTION & DB TESTS ===");

  try {
    // 1. Fetch a valid user
    const [user] = await sql`SELECT user_id, full_name, user_type FROM users LIMIT 1`;
    if (!user) {
      throw new Error("No users found in database to perform wallet tests.");
    }
    const userId = user.user_id;
    const role = user.user_type || "Customer";
    console.log(`Using test user: ID ${userId}, Name: ${user.full_name}, Role: ${role}`);

    // 2. Fetch a valid admin user for approval steps
    const [admin] = await sql`SELECT admin_id, full_name FROM admin_users LIMIT 1`;
    if (!admin) {
      throw new Error("No admins found in database to perform wallet approval tests.");
    }
    const adminId = admin.admin_id;
    console.log(`Using test admin: ID ${adminId}, Name: ${admin.full_name}`);

    // Clean up any existing wallet/transactions for this test user to have a clean sandbox
    console.log("\n[Clean Up] Cleaning existing wallet data for test user...");
    await sql`DELETE FROM wallet_transactions WHERE user_id = ${userId}`;
    await sql`DELETE FROM withdrawal_requests WHERE user_id = ${userId}`;
    await sql`DELETE FROM user_wallets WHERE user_id = ${userId}`;
    await sql`DELETE FROM wallet_audit_logs WHERE user_id = ${userId}`;

    // Helper to get or create wallet
    const getOrCreateWallet = async (tx = sql) => {
      const [existing] = await tx`SELECT * FROM user_wallets WHERE user_id = ${userId}`;
      if (existing) return existing;
      const [newWallet] = await tx`
        INSERT INTO user_wallets (user_id, user_role, available_balance, pending_withdrawal_balance, total_added_fund, total_withdrawn)
        VALUES (${userId}, ${role}, 0.00, 0.00, 0.00, 0.00)
        RETURNING *
      `;
      return newWallet;
    };

    // 3. Test Initial Wallet Creation
    console.log("\n[Test 1] Testing wallet creation...");
    let wallet = await getOrCreateWallet();
    console.log("✔ Wallet created successfully. Balance details:", {
      available: wallet.available_balance,
      pending: wallet.pending_withdrawal_balance,
      total_added: wallet.total_added_fund,
      total_withdrawn: wallet.total_withdrawn
    });

    if (Number(wallet.available_balance) !== 0) {
      throw new Error("New wallet must start with 0.00 available balance.");
    }

    // 4. Test Adding Fund (Credit Flow)
    console.log("\n[Test 2] Testing Add Fund transaction (Credit)...");
    const depositAmount = 1000.00;
    const orderId = `WAL-TEST-${Date.now()}`;

    await sql.begin(async (tx) => {
      // Lock wallet
      const [w] = await tx`SELECT * FROM user_wallets WHERE id = ${wallet.id} FOR UPDATE`;
      
      const newAvail = Number(w.available_balance) + depositAmount;
      const newAdded = Number(w.total_added_fund) + depositAmount;

      // Update wallet
      await tx`
        UPDATE user_wallets SET
          available_balance = ${newAvail},
          total_added_fund = ${newAdded},
          updated_at = NOW()
        WHERE id = ${w.id}
      `;

      // Log transaction
      await tx`
        INSERT INTO wallet_transactions (
          wallet_id, user_id, user_role, transaction_type, source, amount,
          balance_before, balance_after, payment_gateway, payment_order_id, status, remarks
        ) VALUES (
          ${w.id}, ${userId}, ${role}, 'credit', 'Add Fund', ${depositAmount},
          ${w.available_balance}, ${newAvail}, 'razorpay', ${orderId}, 'success', 'Simulated test deposit'
        )
      `;
    });

    // Verify wallet updated
    wallet = await getOrCreateWallet();
    console.log("✔ Deposit verified. New Available Balance:", wallet.available_balance);
    if (Number(wallet.available_balance) !== depositAmount) {
      throw new Error(`Expected balance to be ${depositAmount}, got ${wallet.available_balance}`);
    }

    // 5. Test Withdrawal Request Initiation (Lock balance)
    console.log("\n[Test 3] Testing Withdrawal Request Initiation...");
    const withdrawAmount = 400.00;
    
    let withdrawalRequestId;
    await sql.begin(async (tx) => {
      // Row-level lock wallet
      const [w] = await tx`SELECT * FROM user_wallets WHERE id = ${wallet.id} FOR UPDATE`;
      
      const avail = Number(w.available_balance);
      const pending = Number(w.pending_withdrawal_balance);

      if (avail < withdrawAmount) {
        throw new Error("Insufficient funds for withdrawal request.");
      }

      const newAvail = avail - withdrawAmount;
      const newPending = pending + withdrawAmount;

      // Update balances (lock withdrawal amount)
      await tx`
        UPDATE user_wallets SET
          available_balance = ${newAvail},
          pending_withdrawal_balance = ${newPending},
          updated_at = NOW()
        WHERE id = ${w.id}
      `;

      // Insert request
      const [req] = await tx`
        INSERT INTO withdrawal_requests (
          user_id, user_role, wallet_id, amount, bank_account_holder_name,
          bank_account_number, ifsc_code, bank_name, status
        ) VALUES (
          ${userId}, ${role}, ${w.id}, ${withdrawAmount}, 'John Doe',
          '123456789', 'HDFC0001234', 'HDFC Bank', 'pending'
        ) RETURNING id
      `;
      withdrawalRequestId = req.id;
    });

    // Verify balances updated
    wallet = await getOrCreateWallet();
    console.log("✔ Request created and amount locked. Balances:", {
      available: wallet.available_balance,
      pending: wallet.pending_withdrawal_balance
    });
    if (Number(wallet.available_balance) !== 600.00 || Number(wallet.pending_withdrawal_balance) !== 400.00) {
      throw new Error("Incorrect balance states after withdrawal request creation.");
    }

    // 6. Test Admin Approve Withdrawal
    console.log("\n[Test 4] Testing Admin Approval of Withdrawal...");
    const [requestBeforeApprove] = await sql`SELECT * FROM withdrawal_requests WHERE id = ${withdrawalRequestId}`;
    if (requestBeforeApprove.status !== "pending") {
      throw new Error("Withdrawal request should be in pending status.");
    }

    await sql`
      UPDATE withdrawal_requests SET
        status = 'approved',
        approved_by = ${adminId},
        approved_at = NOW(),
        admin_remarks = 'Test approved'
      WHERE id = ${withdrawalRequestId}
    `;
    console.log("✔ Admin approved the request.");

    // 7. Test Admin Release Funds (Debit Flow completion)
    console.log("\n[Test 5] Testing Admin manual release payout...");
    const payoutRef = "TXN" + Date.now();

    await sql.begin(async (tx) => {
      // Row-level lock request
      const [req] = await tx`SELECT * FROM withdrawal_requests WHERE id = ${withdrawalRequestId} FOR UPDATE`;
      if (req.status !== "approved") {
        throw new Error("Request must be in approved status to release.");
      }

      // Row-level lock wallet
      const [w] = await tx`SELECT * FROM user_wallets WHERE id = ${req.wallet_id} FOR UPDATE`;

      const pending = Number(w.pending_withdrawal_balance);
      const withdrawn = Number(w.total_withdrawn);

      const newPending = pending - Number(req.amount);
      const newWithdrawn = withdrawn + Number(req.amount);

      // Update wallet balance (deduct from pending, add to total withdrawn)
      await tx`
        UPDATE user_wallets SET
          pending_withdrawal_balance = ${newPending},
          total_withdrawn = ${newWithdrawn},
          updated_at = NOW()
        WHERE id = ${w.id}
      `;

      // Update request status to 'released'
      await tx`
        UPDATE withdrawal_requests SET
          status = 'released',
          released_by = ${adminId},
          released_at = NOW(),
          payout_reference_id = ${payoutRef}
        WHERE id = ${req.id}
      `;

      // Log transaction debit
      await tx`
        INSERT INTO wallet_transactions (
          wallet_id, user_id, user_role, transaction_type, source, amount,
          balance_before, balance_after, status, remarks, withdrawal_request_id
        ) VALUES (
          ${w.id}, ${userId}, ${role}, 'debit', 'Withdrawal', ${req.amount},
          ${w.available_balance}, ${w.available_balance}, 'success', ${`Payout released, Ref: ${payoutRef}`}, ${req.id}
        )
      `;
    });

    wallet = await getOrCreateWallet();
    console.log("✔ Payout released. Final wallet balances:", {
      available: wallet.available_balance,
      pending: wallet.pending_withdrawal_balance,
      total_withdrawn: wallet.total_withdrawn
    });

    if (Number(wallet.available_balance) !== 600.00 || Number(wallet.pending_withdrawal_balance) !== 0.00 || Number(wallet.total_withdrawn) !== 400.00) {
      throw new Error("Incorrect balance states after payout release.");
    }

    // 8. Verify Audit Logs and transaction history logs
    console.log("\n[Test 6] Verifying transaction logs in database...");
    const transactions = await sql`
      SELECT transaction_type, source, amount, status, payment_order_id, withdrawal_request_id 
      FROM wallet_transactions 
      WHERE user_id = ${userId}
      ORDER BY created_at ASC
    `;
    console.log("Transactions registered:", transactions);

    if (transactions.length !== 2) {
      throw new Error(`Expected 2 transactions (1 credit, 1 debit), got ${transactions.length}`);
    }

    console.log("\n=== ALL WALLET TRANSACTION & MIGRATION TESTS PASSED ===");
  } catch (error) {
    console.error("\n❌ TEST FAILED:", error.message);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

runTests();
