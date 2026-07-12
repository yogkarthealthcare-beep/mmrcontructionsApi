/**
 * Abstract-like Base class for all payment gateways.
 * Decouples the rest of the application from specific gateway SDKs/APIs.
 */
export default class BaseGateway {
  /**
   * @param {Object} config - The decrypted configuration for this gateway
   */
  constructor(config) {
    if (this.constructor === BaseGateway) {
      throw new Error("BaseGateway is abstract and cannot be instantiated directly.");
    }
    this.config = config;
  }

  /**
   * Creates a payment order on the gateway.
   * @param {string} orderId - Unique internal order ID
   * @param {number} amount - Order amount in standard currency unit (INR)
   * @param {Object} customerDetails - Customer info { name, email, phone }
   * @param {string} callbackUrl - Redirection URL after payment is processed
   * @returns {Promise<Object>} Initialization details needed by frontend
   */
  async createOrder(orderId, amount, customerDetails, callbackUrl) {
    throw new Error("createOrder method must be implemented.");
  }

  /**
   * Verifies the payment backend-to-backend.
   * @param {string} orderId - Unique internal order ID
   * @param {Object} queryParams - Query parameters from success redirect
   * @param {Object} body - Request body from verify API call
   * @returns {Promise<Object>} Verification details { status, gateway_payment_id, gateway_signature, response }
   */
  async verifyPayment(orderId, queryParams, body) {
    throw new Error("verifyPayment method must be implemented.");
  }

  /**
   * Verifies the authenticity of a webhook event signature.
   * @param {Object} headers - Webhook request headers
   * @param {string} rawBody - Raw webhook request body
   * @returns {Promise<boolean>} True if signature is valid, false otherwise
   */
  async verifyWebhook(headers, rawBody) {
    throw new Error("verifyWebhook method must be implemented.");
  }

  /**
   * Abstract placeholder structure for refunds.
   * @param {string} gatewayPaymentId - Gateway payment transaction ID
   * @param {number} amount - Amount to refund
   * @param {string} reason - Reason for refund
   * @returns {Promise<Object>} Refund details
   */
  async refundPayment(gatewayPaymentId, amount, reason) {
    throw new Error("refundPayment method must be implemented.");
  }
}
