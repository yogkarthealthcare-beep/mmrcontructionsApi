import CashfreeGateway from "../payment/CashfreeGateway.js";
import RazorpayGateway from "../payment/RazorpayGateway.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const originalFetch = globalThis.fetch;

try {
  const cashfree = new CashfreeGateway({
    public_key: "cf_test_id",
    client_secret: "cf_test_secret",
    environment_mode: "sandbox",
  });

  const resolvedTemplate = cashfree.resolveReturnUrl(
    "https://app.example/payment/callback?gateway=cashfree&order_id={order_id}",
    "ORDER 123",
  );
  assert(
    resolvedTemplate === "https://app.example/payment/callback?gateway=cashfree&order_id=ORDER%20123",
    "Cashfree callback template did not resolve the order ID.",
  );

  const resolvedPlainUrl = cashfree.resolveReturnUrl(
    "https://app.example/payment/callback",
    "ORDER_456",
  );
  assert(
    resolvedPlainUrl.includes("gateway=cashfree") && resolvedPlainUrl.includes("order_id=ORDER_456"),
    "Cashfree callback did not receive the required gateway and order ID parameters.",
  );

  let cashfreePayload;
  globalThis.fetch = async (_url, options) => {
    cashfreePayload = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        order_id: "ORDER_789",
        payment_session_id: "session_1",
        order_amount: 125,
        order_currency: "INR",
        order_status: "ACTIVE",
      }),
    };
  };

  const cashfreeOrder = await cashfree.createOrder(
    "ORDER_789",
    125,
    {
      customer_id: "1",
      name: "Test Customer",
      email: "test@example.com",
      phone: "9999999999",
    },
    "https://app.example/payment/callback?gateway=cashfree&order_id={order_id}",
  );

  assert(
    cashfreePayload.order_meta.return_url ===
      "https://app.example/payment/callback?gateway=cashfree&order_id=ORDER_789",
    "Cashfree order did not use the saved callback URL.",
  );
  assert(
    cashfreeOrder.checkout_details.callback_url === cashfreePayload.order_meta.return_url,
    "Cashfree checkout response did not map the resolved callback URL.",
  );

  const razorpay = new RazorpayGateway({
    public_key: "rzp_test_id",
    secret_key: "rzp_test_secret",
  });
  const razorpayCallback = "https://app.example/payment/callback";

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      id: "order_rzp_1",
      amount: 12500,
      currency: "INR",
      status: "created",
    }),
  });

  const razorpayOrder = await razorpay.createOrder(
    "LOCAL_ORDER_1",
    125,
    {
      name: "Test Customer",
      email: "test@example.com",
      phone: "9999999999",
    },
    razorpayCallback,
  );

  assert(
    razorpayOrder.checkout_details.callback_url === razorpayCallback,
    "Razorpay callback behavior changed unexpectedly.",
  );

  console.log("Cashfree and Razorpay callback regression tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}
