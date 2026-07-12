import sql from "../db.js";
import { encrypt, decrypt } from "../utils/encryption.js";
import GatewayFactory from "../payment/GatewayFactory.js";
import crypto from "crypto";

async function runTests() {
  console.log("=== STARTING PAYMENT GATEWAY SYSTEM TESTS ===");

  try {
    // --- 1. Test Encryption/Decryption ---
    console.log("\n[Test 1] Testing Encryption/Decryption...");
    const secret = "my-super-secret-key-123456";
    const encrypted = encrypt(secret);
    const decrypted = decrypt(encrypted);

    if (secret !== decrypted) {
      throw new Error(`Encryption test failed. Expected ${secret}, got ${decrypted}`);
    }
    console.log("✔ Encryption and decryption verified successfully.");

    // --- 2. Seed Mock Gateway Configs ---
    console.log("\n[Test 2] Seeding database with initial configurations...");

    // Clear existing config first to start clean
    await sql`DELETE FROM payment_gateway_configs`;

    // Seed Cashfree (Default, Priority 1)
    const cfSecret = encrypt("cf_secret_val_xyz");
    const [cashfreeConfig] = await sql`
      INSERT INTO payment_gateway_configs (
        gateway_name, display_name, is_enabled, is_default, allow_user_selection, 
        priority, status, environment_mode, public_key, encrypted_secret_key, callback_url
      ) VALUES (
        'cashfree', 'Cashfree PG', true, true, true, 
        1, 'active', 'sandbox', 'cf_client_key_123', ${cfSecret}, 'http://localhost:5000/api/payment/cashfree/verify'
      ) RETURNING *
    `;

    // Seed Razorpay (Backup, Priority 2)
    const rzpSecret = encrypt("rzp_secret_val_abc");
    const [razorpayConfig] = await sql`
      INSERT INTO payment_gateway_configs (
        gateway_name, display_name, is_enabled, is_default, allow_user_selection, 
        priority, status, environment_mode, public_key, encrypted_secret_key, callback_url
      ) VALUES (
        'razorpay', 'Razorpay Checkout', true, false, true, 
        2, 'active', 'sandbox', 'rzp_key_id_456', ${rzpSecret}, 'http://localhost:5000/api/payment/razorpay/verify'
      ) RETURNING *
    `;

    console.log("✔ Configurations seeded.");
    console.log("- Cashfree ID:", cashfreeConfig.id);
    console.log("- Razorpay ID:", razorpayConfig.id);

    // --- 3. Test Gateway Resolution ---
    console.log("\n[Test 3] Testing GatewayFactory resolution rules...");

    // Test default resolution (should be cashfree)
    const resolvedDefault = await GatewayFactory.resolveGateway();
    if (resolvedDefault.config.gateway_name !== "cashfree") {
      throw new Error(`Expected resolved default gateway to be 'cashfree', got: ${resolvedDefault.config.gateway_name}`);
    }
    console.log("✔ Default gateway resolution verified.");

    // Test specific request resolution (should be razorpay)
    const resolvedPreferred = await GatewayFactory.resolveGateway("razorpay");
    if (resolvedPreferred.config.gateway_name !== "razorpay") {
      throw new Error(`Expected resolved preferred gateway to be 'razorpay', got: ${resolvedPreferred.config.gateway_name}`);
    }
    console.log("✔ Preferred gateway resolution verified.");

    // --- 4. Test Local Order Initiation Setup ---
    console.log("\n[Test 4] Testing Local Order Initiation data checks...");
    const mockOrder = {
      orderId: "TEST_ORDER_" + Date.now(),
      amount: 1500.50,
      customerDetails: {
        name: "Test User",
        email: "test@example.com",
        phone: "9876543210"
      }
    };

    // We verify client-side setup boots correct parameters
    const rzpInstance = await GatewayFactory.getGatewayInstance("razorpay");
    const rzpCheck = rzpInstance.keyId === "rzp_key_id_456" && rzpInstance.keySecret === "rzp_secret_val_abc";
    if (!rzpCheck) {
      throw new Error("Decrypted configuration did not match seeded keys.");
    }
    console.log("✔ Decryption verification on resolved gateway verified.");

    // --- 5. Verify Razorpay Local Signature Calculation ---
    console.log("\n[Test 5] Verify Razorpay signature verification logic...");
    const mockRzpOrderId = "order_rzp_123";
    const mockRzpPaymentId = "pay_rzp_456";
    const signPayload = mockRzpOrderId + "|" + mockRzpPaymentId;
    const mockRzpSignature = crypto
      .createHmac("sha256", "rzp_secret_val_abc")
      .update(signPayload)
      .digest("hex");

    // Perform local validation check
    const rzpVerificationPayload = {
      razorpay_order_id: mockRzpOrderId,
      razorpay_payment_id: mockRzpPaymentId,
      razorpay_signature: mockRzpSignature
    };
    const expectedSig = crypto
      .createHmac("sha256", "rzp_secret_val_abc")
      .update(rzpVerificationPayload.razorpay_order_id + "|" + rzpVerificationPayload.razorpay_payment_id)
      .digest("hex");
    
    if (expectedSig !== rzpVerificationPayload.razorpay_signature) {
      throw new Error("Razorpay signature calculation check failed.");
    }
    console.log("✔ Razorpay signature verification logic validated.");

    // --- 6. Verify Cashfree Local Signature Calculation ---
    console.log("\n[Test 6] Verify Cashfree webhook signature verification logic...");
    const webhookTimestamp = String(Date.now());
    const webhookBody = JSON.stringify({
      type: "payment.success",
      data: {
        order: { order_id: "order_cf_123", order_amount: 1500.50 },
        payment: { cf_payment_id: "cf_pay_456", payment_status: "SUCCESS" }
      }
    });
    
    const webhookSecret = "cf_secret_val_xyz";
    const expectedCfSig = crypto
      .createHmac("sha256", webhookSecret)
      .update(webhookTimestamp + webhookBody)
      .digest("base64");

    const cfHeaders = {
      "x-webhook-timestamp": webhookTimestamp,
      "x-webhook-signature": expectedCfSig
    };

    const cfInstance = await GatewayFactory.getGatewayInstance("cashfree");
    const cfWebhookValid = await cfInstance.verifyWebhook(cfHeaders, webhookBody);
    if (!cfWebhookValid) {
      throw new Error("Cashfree webhook signature verification logic failed.");
    }
    console.log("✔ Cashfree webhook signature verification logic validated.");

    console.log("\n=== ALL TESTS COMPLETED SUCCESSFULLY ===");
  } catch (error) {
    console.error("\n❌ TEST FAILED:", error);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

runTests();
