import crypto from "crypto";
import BaseGateway from "./BaseGateway.js";

export default class PayUGateway extends BaseGateway {
  constructor(config) {
    super(config);
    this.key = config.public_key;
    this.salt = config.secret_key;
  }

  getEndpoint() {
    const mode = String(this.config.environment_mode || "test").toLowerCase();
    return mode === "live" || mode === "production"
      ? "https://secure.payu.in/_payment"
      : "https://test.payu.in/_payment";
  }

  assertConfigured() {
    if (!this.key || !this.salt) {
      throw new Error("PayU Merchant Key or Salt is missing in config.");
    }
  }

  formatAmount(amount) {
    return Number(amount).toFixed(2);
  }

  sha512(value) {
    return crypto.createHash("sha512").update(value).digest("hex");
  }

  createPaymentHash(fields) {
    const sequence = [
      this.key,
      fields.txnid,
      fields.amount,
      fields.productinfo,
      fields.firstname,
      fields.email,
      fields.udf1 || "",
      fields.udf2 || "",
      fields.udf3 || "",
      fields.udf4 || "",
      fields.udf5 || "",
      "",
      "",
      "",
      "",
      "",
      this.salt,
    ];
    return this.sha512(sequence.join("|"));
  }

  createResponseHash(fields) {
    const sequence = [
      this.salt,
      fields.status || "",
      "",
      "",
      "",
      "",
      "",
      fields.udf5 || "",
      fields.udf4 || "",
      fields.udf3 || "",
      fields.udf2 || "",
      fields.udf1 || "",
      fields.email || "",
      fields.firstname || "",
      fields.productinfo || "",
      fields.amount || "",
      fields.txnid || "",
      this.key,
    ];
    return this.sha512(sequence.join("|"));
  }

  buildReturnUrl(callbackUrl, orderId, outcome) {
    const configuredUrl = String(callbackUrl || "").trim();
    const baseUrl = configuredUrl || this.config.success_url || this.config.failure_url || "";
    if (!baseUrl) return "";

    try {
      const url = new URL(baseUrl.replaceAll("{order_id}", encodeURIComponent(orderId)));
      if (!url.searchParams.has("gateway")) url.searchParams.set("gateway", "payu");
      if (!url.searchParams.has("order_id")) url.searchParams.set("order_id", orderId);
      if (!url.searchParams.has("outcome")) url.searchParams.set("outcome", outcome);
      return url.toString();
    } catch {
      const separator = baseUrl.includes("?") ? "&" : "?";
      return `${baseUrl}${separator}gateway=payu&order_id=${encodeURIComponent(orderId)}&outcome=${encodeURIComponent(outcome)}`;
    }
  }

  async createOrder(orderId, amount, customerDetails, callbackUrl) {
    this.assertConfigured();

    const txnid = String(orderId);
    const fields = {
      key: this.key,
      txnid,
      amount: this.formatAmount(amount),
      productinfo: "MMR Constructions Payment",
      firstname: customerDetails.name || "Customer",
      email: customerDetails.email || "customer@example.com",
      phone: customerDetails.phone || "9999999999",
      surl: this.buildReturnUrl(callbackUrl, orderId, "success"),
      furl: this.buildReturnUrl(callbackUrl, orderId, "failure"),
      udf1: "",
      udf2: "",
      udf3: "",
      udf4: "",
      udf5: "",
    };

    fields.hash = this.createPaymentHash(fields);

    return {
      gateway_order_id: txnid,
      amount: Number(fields.amount),
      currency: "INR",
      status: "created",
      raw_response: { gateway_order_id: txnid, endpoint: this.getEndpoint() },
      checkout_details: {
        type: "payu_form",
        action: this.getEndpoint(),
        method: "POST",
        fields,
      },
    };
  }

  async verifyPayment(orderId, queryParams, body) {
    this.assertConfigured();

    const payload = { ...queryParams, ...body };
    const txnid = payload.txnid || orderId;
    const status = String(payload.status || "").toLowerCase();
    const receivedHash = String(payload.hash || "");

    if (!txnid || !receivedHash) {
      throw new Error("Missing PayU transaction ID or response hash.");
    }

    const expectedHash = this.createResponseHash({
      ...payload,
      txnid,
      amount: payload.amount ? this.formatAmount(payload.amount) : payload.amount,
    });

    const receivedBuffer = Buffer.from(receivedHash, "hex");
    const expectedBuffer = Buffer.from(expectedHash, "hex");
    const isValid = receivedBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(receivedBuffer, expectedBuffer);

    if (!isValid) {
      throw new Error("PayU payment verification failed: hash mismatch.");
    }

    if (status !== "success") {
      throw new Error(`PayU payment failed. Status: ${payload.status || "unknown"}`);
    }

    return {
      status: "success",
      gateway_payment_id: payload.mihpayid || txnid,
      gateway_order_id: txnid,
      gateway_signature: receivedHash,
      amount: Number(payload.amount),
      currency: "INR",
      raw_response: payload,
    };
  }

  async verifyWebhook() {
    return false;
  }

  async refundPayment() {
    throw new Error("PayU refunds are not implemented in this gateway module yet.");
  }
}
