import app from "../server.js";
import jwt from "jsonwebtoken";
import sql from "../db.js";
import { encrypt } from "../utils/encryption.js";

const PORT = 5000; // default server port

async function runTests() {
  console.log("=== STARTING PAYMENT API SECURITY & VALIDATION TESTS ===");

  // Let the automatically started Express server boot up
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    const jwtSecret = process.env.JWT_SECRET || "mmrcontruction123";
    
    // Generate test JWT tokens
    const userToken = jwt.sign(
      { user_id: 999, user_type: "Customer", email: "user@example.com" },
      jwtSecret
    );
    const adminToken = jwt.sign(
      { admin_id: 1, email: "admin@example.com", full_name: "Super Admin", role: "SuperAdmin" },
      jwtSecret
    );
    const invalidAdminToken = jwt.sign(
      { user_id: 999, user_type: "Customer", email: "user@example.com" }, // No role field
      jwtSecret
    );

    // Seed database with mock gateway configs so factory can resolve
    console.log("\n[Test] Seeding configurations with encrypted credentials...");
    await sql`DELETE FROM payment_gateway_configs`;
    
    const rzpSecretEnc = encrypt("rzp_secret_val_abc");
    await sql`
      INSERT INTO payment_gateway_configs (
        gateway_name, display_name, is_enabled, is_default, allow_user_selection, 
        priority, status, environment_mode, public_key, encrypted_secret_key, callback_url
      ) VALUES (
        'razorpay', 'Razorpay Checkout', true, true, true, 
        1, 'active', 'sandbox', 'rzp_key_id_456', ${rzpSecretEnc}, 'http://localhost:5000/api/payment/razorpay/verify'
      )
    `;

    // Define some test helper headers
    const userHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` };
    const adminHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` };
    const invalidAdminHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${invalidAdminToken}` };

    // --- TEST 1: Admin Authorization Checks ---
    console.log("\n[Test 1] Testing Admin Authorization protection...");
    
    // Case A: Valid Admin Token
    const resAdminOk = await fetch(`http://localhost:${PORT}/api/admin/payment-gateways`, { headers: adminHeaders });
    if (resAdminOk.status === 200) {
      console.log("✔ Admin accessing admin APIs with role is ALLOWED (200 OK).");
    } else {
      throw new Error(`Admin role check failed. Expected 200, got ${resAdminOk.status}`);
    }

    // Case B: User Token without Role
    const resAdminForbidden = await fetch(`http://localhost:${PORT}/api/admin/payment-gateways`, { headers: invalidAdminHeaders });
    if (resAdminForbidden.status === 403) {
      console.log("✔ User accessing admin APIs without role is FORBIDDEN (403 Forbidden).");
    } else {
      throw new Error(`Admin role check failed. Expected 403, got ${resAdminForbidden.status}`);
    }

    // Case C: No Token
    const resAdminUnauthorized = await fetch(`http://localhost:${PORT}/api/admin/payment-gateways`, { headers: {} });
    if (resAdminUnauthorized.status === 401) {
      console.log("✔ Accessing admin APIs without token is UNAUTHORIZED (401 Unauthorized).");
    } else {
      throw new Error(`Admin token presence check failed. Expected 401, got ${resAdminUnauthorized.status}`);
    }

    // --- TEST 2: Zod Schema Input Validation ---
    console.log("\n[Test 2] Testing Zod schema input validation...");

    // Case A: Invalid customer email and mobile
    const resInvalidInput = await fetch(`http://localhost:${PORT}/api/payment/initiate`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({
        order_id: "ORDER_1",
        amount: 100,
        customer_name: "John Doe",
        customer_email: "not-an-email", // Invalid email
        customer_mobile: "123" // Too short mobile
      })
    });
    const dataInvalidInput = await resInvalidInput.json();
    if (resInvalidInput.status === 400 && dataInvalidInput.message.includes("Validation error")) {
      console.log("✔ Input validation successfully rejected bad email and mobile formats (400 Bad Request).");
    } else {
      throw new Error(`Zod validation failed to block bad inputs. Got status ${resInvalidInput.status}`);
    }

    // Case B: Zero or negative amount
    const resZeroAmount = await fetch(`http://localhost:${PORT}/api/payment/initiate`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({
        order_id: "ORDER_2",
        amount: -50,
        customer_name: "John Doe",
        customer_email: "john@example.com",
        customer_mobile: "9876543210"
      })
    });
    if (resZeroAmount.status === 400) {
      console.log("✔ Input validation successfully rejected negative amount (400 Bad Request).");
    } else {
      throw new Error(`Zod validation failed to block negative amount. Got status ${resZeroAmount.status}`);
    }

    // --- TEST 3: Duplicate Payment Protection ---
    console.log("\n[Test 3] Testing duplicate payment prevention...");
    const dupOrderId = "DUP_ORDER_" + Date.now();
    
    // First, seed a transaction marked as 'success'
    await sql`
      INSERT INTO payment_transactions (
        order_id, gateway_name, amount, payment_status, customer_name, customer_email, customer_mobile
      ) VALUES (
        ${dupOrderId}, 'razorpay', 250, 'success', 'Jane Doe', 'jane@example.com', '9876543210'
      )
    `;

    // Try creating razorpay order directly for this paid order id
    const resDupRzp = await fetch(`http://localhost:${PORT}/api/payment/razorpay/create-order`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({
        order_id: dupOrderId,
        amount: 250,
        customer_name: "Jane Doe",
        customer_email: "jane@example.com",
        customer_mobile: "9876543210"
      })
    });
    
    if (resDupRzp.status === 400) {
      const dataDupRzp = await resDupRzp.json();
      if (dataDupRzp.message.includes("already been successfully paid")) {
        console.log("✔ Successfully prevented duplicate order creation on Razorpay endpoint (400 Bad Request).");
      } else {
        throw new Error(`Unexpected message: ${dataDupRzp.message}`);
      }
    } else {
      throw new Error(`Failed to block duplicate order creation on Razorpay. Got status ${resDupRzp.status}`);
    }

    // --- TEST 4: Rate Limiting ---
    console.log("\n[Test 4] Testing payment endpoint rate limiting...");
    let triggered429 = false;
    
    // Make 20 rapid requests to trigger the 15/min rate limit
    for (let i = 0; i < 20; i++) {
      const resRate = await fetch(`http://localhost:${PORT}/api/payment/initiate`, {
        method: "POST",
        headers: userHeaders,
        body: JSON.stringify({
          order_id: `LIMIT_ORDER_${i}_` + Date.now(),
          amount: 100,
          customer_name: "John Limit",
          customer_email: "limit@example.com",
          customer_mobile: "9876543210"
        })
      });
      if (resRate.status === 429) {
        triggered429 = true;
        console.log("✔ Rate limiter triggered successfully (429 Too Many Requests) at attempt", i + 1);
        break;
      }
    }
    
    if (!triggered429) {
      throw new Error("Rate limiting did not trigger after 20 rapid requests.");
    }

    console.log("\n=== ALL API SECURITY & VALIDATION TESTS PASSED SUCCESSFULLY ===");
    cleanupAndExit(0);
  } catch (err) {
    console.error("\n❌ TEST FAILED:", err.message);
    cleanupAndExit(1);
  }
}

function cleanupAndExit(code) {
  const serverInstance = globalThis.__mmrApiServer;
  if (serverInstance) {
    serverInstance.close(() => {
      console.log("Dev server closed successfully.");
      sql.end().then(() => {
        process.exit(code);
      });
    });
  } else {
    sql.end().then(() => {
      process.exit(code);
    });
  }
}

runTests();
