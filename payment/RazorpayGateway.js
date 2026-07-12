import crypto from "crypto";
import BaseGateway from "./BaseGateway.js";

export default class RazorpayGateway extends BaseGateway {
  constructor(config) {
    super(config);
    this.keyId = config.public_key;
    this.keySecret = config.secret_key;
    this.webhookSecret = config.webhook_secret;
  }

  getAuthHeader() {
    if (!this.keyId || !this.keySecret) {
      throw new Error("Razorpay Key ID or Key Secret is missing in config.");
    }
    const credentials = `${this.keyId}:${this.keySecret}`;
    return `Basic ${Buffer.from(credentials).toString("base64")}`;
  }

  /**
   * Create Razorpay Order
   * @param {string} orderId - Local order ID
   * @param {number} amount - Amount in INR
   * @param {Object} customerDetails - Customer info
   * @param {string} callbackUrl - URL where payment results are sent
   */
  async createOrder(orderId, amount, customerDetails, callbackUrl) {
    const amountInPaise = Math.round(amount * 100);

    const payload = {
      amount: amountInPaise,
      currency: "INR",
      receipt: orderId,
      notes: {
        customer_name: customerDetails.name || "",
        customer_email: customerDetails.email || "",
        customer_mobile: customerDetails.phone || "",
      },
    };

    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.getAuthHeader(),
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.description || `Razorpay order creation failed: ${response.statusText}`);
    }

    return {
      gateway_order_id: data.id,
      amount: data.amount,
      currency: data.currency,
      status: data.status,
      raw_response: data,
      // Frontend values to boot Razorpay Checkout Checkout
      checkout_details: {
        key: this.keyId,
        amount: data.amount,
        currency: data.currency,
        name: "MMR Constructions",
        order_id: data.id,
        prefill: {
          name: customerDetails.name,
          email: customerDetails.email,
          contact: customerDetails.phone,
        },
        callback_url: callbackUrl,
      },
    };
  }

  /**
   * Verify signature and status of payment on backend
   * @param {string} orderId - Local order ID
   * @param {Object} queryParams - Redirection parameters (e.g. razorpay_signature)
   * @param {Object} body - Verify body (razorpay_order_id, razorpay_payment_id, razorpay_signature)
   */
  async verifyPayment(orderId, queryParams, body) {
    const payload = { ...queryParams, ...body };
    const rzpOrderId = payload.razorpay_order_id;
    const rzpPaymentId = payload.razorpay_payment_id;
    const rzpSignature = payload.razorpay_signature;

    if (!rzpOrderId || !rzpPaymentId || !rzpSignature) {
      throw new Error("Missing Razorpay signature, payment ID, or order ID for verification.");
    }

    // 1. Verify Signature locally
    const signPayload = rzpOrderId + "|" + rzpPaymentId;
    const expectedSignature = crypto
      .createHmac("sha256", this.keySecret)
      .update(signPayload)
      .digest("hex");

    const receivedSignature = Buffer.from(rzpSignature);
    const expectedSignatureBuffer = Buffer.from(expectedSignature);
    const isSignatureValid = receivedSignature.length === expectedSignatureBuffer.length &&
      crypto.timingSafeEqual(receivedSignature, expectedSignatureBuffer);

    if (!isSignatureValid) {
      throw new Error("Razorpay payment verification failed: Signature mismatch.");
    }

    // 2. Fetch details from Razorpay to verify amount and status (Backend verification)
    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${rzpPaymentId}`, {
      headers: {
        Authorization: this.getAuthHeader(),
      },
    });

    const paymentDetails = await paymentResponse.json();
    if (!paymentResponse.ok) {
      throw new Error(`Failed to fetch Razorpay payment details: ${paymentResponse.statusText}`);
    }

    // Verify order receipt matches
    const fetchedReceipt = paymentDetails.notes?.receipt || paymentDetails.notes?.order_id || "";
    const isOrderMatching = paymentDetails.order_id === rzpOrderId;
    const isStatusOk = ["captured", "authorized"].includes(paymentDetails.status);

    if (!isOrderMatching || !isStatusOk) {
      throw new Error(`Razorpay payment status verification failed. Status: ${paymentDetails.status}`);
    }

    return {
      status: "success",
      gateway_payment_id: rzpPaymentId,
      gateway_order_id: rzpOrderId,
      gateway_signature: rzpSignature,
      amount: paymentDetails.amount / 100,
      currency: paymentDetails.currency,
      raw_response: paymentDetails,
    };
  }

  /**
   * Verify Webhook Signature
   * @param {Object} headers - Express headers
   * @param {string} rawBody - Raw body buffer/string
   */
  async verifyWebhook(headers, rawBody) {
    const signature = headers["x-razorpay-signature"];
    if (!signature || !this.webhookSecret) {
      return false;
    }

    const expectedSignature = crypto
      .createHmac("sha256", this.webhookSecret)
      .update(rawBody)
      .digest("hex");

    return signature === expectedSignature;
  }

  /**
   * Refund payment
   * @param {string} gatewayPaymentId - Razorpay payment ID
   * @param {number} amount - Amount in INR
   * @param {string} reason - Refund reason
   */
  async refundPayment(gatewayPaymentId, amount, reason) {
    const payload = {
      amount: Math.round(amount * 100),
      notes: {
        reason: reason || "Admin Initiated Refund",
      },
    };

    const response = await fetch(`https://api.razorpay.com/v1/payments/${gatewayPaymentId}/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.getAuthHeader(),
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.description || `Razorpay refund failed: ${response.statusText}`);
    }

    return {
      refund_id: data.id,
      amount: data.amount / 100,
      status: data.status,
      raw_response: data,
    };
  }
}
