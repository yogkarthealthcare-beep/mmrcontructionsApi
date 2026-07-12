import crypto from "crypto";
import BaseGateway from "./BaseGateway.js";

export default class CashfreeGateway extends BaseGateway {
  constructor(config) {
    super(config);
    this.clientId = config.public_key;
    this.clientSecret = config.client_secret || config.secret_key;
    this.webhookSecret = config.webhook_secret;
  }

  getBaseUrl() {
    const mode = String(this.config.environment_mode || "sandbox").toLowerCase();
    return mode === "production"
      ? "https://api.cashfree.com/pg"
      : "https://sandbox.cashfree.com/pg";
  }

  getHeaders() {
    if (!this.clientId || !this.clientSecret) {
      throw new Error("Cashfree Client ID or Client Secret is missing in config.");
    }
    return {
      "x-api-version": "2023-08-01",
      "x-client-id": this.clientId,
      "x-client-secret": this.clientSecret,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  resolveReturnUrl(callbackUrl, orderId) {
    const configuredUrl = String(callbackUrl || "").trim();
    if (!configuredUrl) return configuredUrl;

    if (configuredUrl.includes("{order_id}")) {
      return configuredUrl.replaceAll("{order_id}", encodeURIComponent(orderId));
    }

    try {
      const returnUrl = new URL(configuredUrl);
      if (!returnUrl.searchParams.has("order_id")) {
        returnUrl.searchParams.set("order_id", orderId);
      }
      if (!returnUrl.searchParams.has("gateway")) {
        returnUrl.searchParams.set("gateway", "cashfree");
      }
      return returnUrl.toString();
    } catch {
      const separator = configuredUrl.includes("?") ? "&" : "?";
      return `${configuredUrl}${separator}gateway=cashfree&order_id=${encodeURIComponent(orderId)}`;
    }
  }

  /**
   * Create Cashfree Order and Session
   * @param {string} orderId - Local order ID
   * @param {number} amount - Amount in INR
   * @param {Object} customerDetails - Customer info
   * @param {string} callbackUrl - Return URL after checkout redirect
   */
  async createOrder(orderId, amount, customerDetails, callbackUrl) {
    const returnUrl = this.resolveReturnUrl(callbackUrl, orderId);
    const payload = {
      order_id: orderId,
      order_amount: Number(Number(amount).toFixed(2)),
      order_currency: "INR",
      customer_details: {
        customer_id: customerDetails.customer_id || orderId,
        customer_name: customerDetails.name || "Guest",
        customer_email: customerDetails.email || "guest@example.com",
        customer_phone: customerDetails.phone || "9999999999",
      },
      order_meta: {
        return_url: returnUrl,
      },
    };

    const response = await fetch(`${this.getBaseUrl()}/orders`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || `Cashfree order creation failed: ${response.statusText}`);
    }

    return {
      gateway_order_id: data.order_id,
      payment_session_id: data.payment_session_id,
      amount: data.order_amount,
      currency: data.order_currency,
      status: data.order_status,
      raw_response: data,
      // Frontend values to boot Cashfree SDK checkout
      checkout_details: {
        payment_session_id: data.payment_session_id,
        order_id: data.order_id,
        environment: String(this.config.environment_mode || "sandbox").toLowerCase() === "production" ? "production" : "sandbox",
        callback_url: returnUrl,
      },
    };
  }

  /**
   * Verify Cashfree order state backend-to-backend
   * @param {string} orderId - Local order ID
   */
  async verifyPayment(orderId, queryParams, body) {
    const response = await fetch(`${this.getBaseUrl()}/orders/${orderId}`, {
      headers: this.getHeaders(),
    });

    const orderDetails = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to fetch Cashfree order: ${orderDetails.message || response.statusText}`);
    }

    const isPaid = orderDetails.order_status === "PAID";
    if (!isPaid) {
      throw new Error(`Cashfree payment verification failed. Status: ${orderDetails.order_status}`);
    }

    // Retrieve last transaction details if available
    const paymentsResponse = await fetch(`${this.getBaseUrl()}/orders/${orderId}/payments`, {
      headers: this.getHeaders(),
    });
    let transactionId = null;
    let paymentDetails = orderDetails;
    if (paymentsResponse.ok) {
      const payments = await paymentsResponse.json();
      if (Array.isArray(payments) && payments.length > 0) {
        // Find successful or latest payment
        const successfulPayment = payments.find((p) => p.payment_status === "SUCCESS") || payments[0];
        transactionId = successfulPayment.cf_payment_id;
        paymentDetails = successfulPayment;
      }
    }

    return {
      status: "success",
      gateway_payment_id: transactionId || orderDetails.cf_order_id || String(orderId),
      gateway_order_id: orderDetails.order_id,
      gateway_signature: null, // Cashfree REST API response validation doesn't return redirect signature
      amount: orderDetails.order_amount,
      currency: orderDetails.order_currency,
      raw_response: { order: orderDetails, payment: paymentDetails },
    };
  }

  /**
   * Verify Webhook Signature
   * @param {Object} headers - Express headers
   * @param {string} rawBody - Raw body buffer/string
   */
  async verifyWebhook(headers, rawBody) {
    const timestamp = headers["x-webhook-timestamp"];
    const signature = headers["x-webhook-signature"];
    const key = this.webhookSecret || this.clientSecret;

    if (!timestamp || !signature || !key) {
      return false;
    }

    const signPayload = timestamp + rawBody;
    const expectedSignature = crypto
      .createHmac("sha256", key)
      .update(signPayload)
      .digest("base64");

    return signature === expectedSignature;
  }

  /**
   * Refund payment
   * @param {string} gatewayPaymentId - Cashfree cf_payment_id or orderId
   * @param {number} amount - Amount in INR
   * @param {string} reason - Refund reason
   */
  async refundPayment(gatewayPaymentId, amount, reason) {
    // Note: Cashfree refunds can be created against the order_id in newer APIs
    const payload = {
      refund_amount: Number(Number(amount).toFixed(2)),
      refund_id: `ref_${Date.now()}`,
      refund_note: reason || "Admin Initiated Refund",
    };

    // Use orderId as parameter for standard v3 refund endpoint
    const response = await fetch(`${this.getBaseUrl()}/orders/${gatewayPaymentId}/refunds`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || `Cashfree refund failed: ${response.statusText}`);
    }

    return {
      refund_id: data.refund_id,
      amount: data.refund_amount,
      status: data.refund_status,
      raw_response: data,
    };
  }
}
