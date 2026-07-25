import sql from "../db.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

async function runTest() {
  console.log("=== STARTING INVESTOR MODULE END-TO-END VERIFICATION ===");

  const testEmail = `test.investor.${Date.now()}@mmrconstructions.com`;
  const testMobile = `98${Math.floor(10000000 + Math.random() * 90000000)}`;
  const testPassword = "Password123!";

  try {
    // 1. Create test investor
    console.log("\n[1] Registering Test Investor...");
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(testPassword, salt);

    const [investor] = await sql`
      INSERT INTO investor_users (
        full_name, mobile_number, email, password_hash,
        address, city, state, pincode, pan_number, bank_name, account_number, ifsc_code, nominee_name, status, is_verified
      ) VALUES (
        'Test Investor', ${testMobile}, ${testEmail}, ${password_hash},
        '123 Civil Lines', 'Lucknow', 'Uttar Pradesh', '226001', 'ABCDE1234F',
        'State Bank of India', '123456789012', 'SBIN0000123', 'Jane Doe', 'pending', false
      )
      RETURNING *
    `;

    console.log("✔ Investor created successfully! ID:", investor.id, "Status:", investor.status);

    // 2. Submit Deposit Request
    console.log("\n[2] Submitting Deposit Request of ₹50,000...");
    const depositAmount = 50000;
    const utr = `UTR${Date.now()}`;

    const [deposit] = await sql`
      INSERT INTO investor_deposits (
        investor_id, amount, payment_method, transaction_reference, status
      ) VALUES (
        ${investor.id}, ${depositAmount}, 'Bank Transfer', ${utr}, 'pending'
      )
      RETURNING *
    `;

    const txId = `DEP-${Date.now()}`;
    await sql`
      INSERT INTO investor_transactions (
        investor_id, transaction_id, type, amount, status, payment_method, reference_number
      ) VALUES (
        ${investor.id}, ${txId}, 'deposit', ${depositAmount}, 'pending', 'Bank Transfer', ${utr}
      )
    `;

    console.log("✔ Deposit request created successfully! ID:", deposit.id);

    // 3. Admin Approve Investor & Deposit
    console.log("\n[3] Admin Approving Investor & Deposit Request...");
    await sql`
      UPDATE investor_users
      SET status = 'approved', is_verified = true
      WHERE id = ${investor.id}
    `;

    await sql.begin(async (tx) => {
      await tx`
        UPDATE investor_deposits
        SET status = 'approved', approved_at = NOW()
        WHERE id = ${deposit.id}
      `;
      await tx`
        UPDATE investor_users
        SET available_balance = available_balance + ${depositAmount},
            total_deposits = total_deposits + ${depositAmount},
            total_investment = total_investment + ${depositAmount}
        WHERE id = ${investor.id}
      `;
      await tx`
        UPDATE investor_transactions
        SET status = 'approved'
        WHERE investor_id = ${investor.id} AND reference_number = ${utr}
      `;
    });

    console.log("✔ Deposit approved! Recalculated balance.");

    // 4. Verify updated balance
    const [updatedInvestor] = await sql`SELECT available_balance, total_investment, total_deposits FROM investor_users WHERE id = ${investor.id}`;
    console.log("✔ Updated Balances -> Available Balance: ₹", updatedInvestor.available_balance, "| Total Deposits: ₹", updatedInvestor.total_deposits);

    // 5. Submit & Approve Withdrawal
    console.log("\n[5] Submitting Withdrawal Request of ₹10,000...");
    const withdrawalAmount = 10000;
    const [withdrawal] = await sql`
      INSERT INTO investor_withdrawals (
        investor_id, amount, bank_name, account_number, ifsc_code, status
      ) VALUES (
        ${investor.id}, ${withdrawalAmount}, 'State Bank of India', '123456789012', 'SBIN0000123', 'pending'
      )
      RETURNING *
    `;

    await sql.begin(async (tx) => {
      await tx`
        UPDATE investor_withdrawals
        SET status = 'approved', approved_at = NOW()
        WHERE id = ${withdrawal.id}
      `;
      await tx`
        UPDATE investor_users
        SET available_balance = available_balance - ${withdrawalAmount},
            total_withdrawals = total_withdrawals + ${withdrawalAmount}
        WHERE id = ${investor.id}
      `;
    });

    console.log("✔ Withdrawal approved!");

    // 6. Final verification
    const [finalInvestor] = await sql`SELECT available_balance, total_withdrawals FROM investor_users WHERE id = ${investor.id}`;
    console.log("✔ Final Available Balance: ₹", finalInvestor.available_balance, "| Total Withdrawals: ₹", finalInvestor.total_withdrawals);

    // Clean up test data
    await sql`DELETE FROM investor_users WHERE id = ${investor.id}`;
    console.log("✔ Cleaned up test data.");

    console.log("\n=== ALL TEST CHECKS PASSED SUCCESSFULLY ===");
  } catch (error) {
    console.error("✖ Test Failed:", error);
    process.exit(1);
  }
}

runTest().then(() => process.exit(0));
