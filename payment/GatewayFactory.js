import sql from "../db.js";
import { decrypt } from "../utils/encryption.js";
import RazorpayGateway from "./RazorpayGateway.js";
import CashfreeGateway from "./CashfreeGateway.js";
import PayUGateway from "./PayUGateway.js";

export default class GatewayFactory {
  /**
   * Fetches the configuration for a given gateway, decrypts it, and returns the gateway instance.
   * @param {string} gatewayName - Name of the gateway (razorpay, cashfree, etc.)
   * @returns {Promise<BaseGateway>} The gateway instance
   */
  static async getGatewayInstance(gatewayName) {
    const [config] = await sql`
      SELECT * FROM payment_gateway_configs 
      WHERE gateway_name = ${gatewayName.toLowerCase()} AND is_enabled = true
    `;

    if (!config) {
      throw new Error(`Payment gateway '${gatewayName}' is not configured or disabled.`);
    }

    return this.createInstance(config);
  }

  /**
   * Automatically resolves the gateway based on status, default settings, priority, user choice, and fallback rules.
   * @param {string|null} preferredGateway - Optional user-selected gateway
   * @returns {Promise<BaseGateway>} The resolved active gateway instance
   */
  static async resolveGateway(preferredGateway = null) {
    // 1. Fetch all enabled configurations ordered by priority and default status
    const configs = await sql`
      SELECT * FROM payment_gateway_configs 
      WHERE is_enabled = true 
      ORDER BY is_default DESC, priority ASC, created_at DESC
    `;

    if (configs.length === 0) {
      throw new Error("No payment gateways are currently enabled in the system.");
    }

    // 2. User selection logic
    if (preferredGateway) {
      const preferred = configs.find(
        (c) => c.gateway_name === preferredGateway.toLowerCase()
      );
      if (preferred) {
        // Check if user selection is allowed on this config or globally enabled
        const userSelectionAllowed = configs.some((c) => c.allow_user_selection === true);
        if (userSelectionAllowed) {
          return this.createInstance(preferred);
        }
      }
    }

    // 3. Fallback logic: check default gateway
    const defaultGateway = configs.find((c) => c.is_default === true) || configs[0];

    // If default gateway exists, return it
    if (defaultGateway) {
      // If default gateway is in maintenance or inactive, but fallback is enabled, find the next priority active gateway
      if (defaultGateway.status !== "active" && defaultGateway.fallback_enabled) {
        const fallback = configs.find(
          (c) => c.gateway_name !== defaultGateway.gateway_name && c.status === "active"
        );
        if (fallback) {
          console.warn(`Default gateway is inactive/maintenance. Falling back to: ${fallback.gateway_name}`);
          return this.createInstance(fallback);
        }
      }
      return this.createInstance(defaultGateway);
    }

    throw new Error("Could not resolve an active payment gateway.");
  }

  /**
   * Helper to decrypt credentials and create a gateway strategy instance
   * @param {Object} config - Config row from DB
   * @returns {BaseGateway} Strategy instance
   */
  static createInstance(config) {
    // Decrypt secrets
    const decryptedConfig = {
      ...config,
      secret_key: config.encrypted_secret_key ? decrypt(config.encrypted_secret_key) : null,
      client_secret: config.encrypted_client_secret ? decrypt(config.encrypted_client_secret) : null,
      webhook_secret: config.encrypted_webhook_secret ? decrypt(config.encrypted_webhook_secret) : null,
    };

    switch (config.gateway_name.toLowerCase()) {
      case "razorpay":
        return new RazorpayGateway(decryptedConfig);
      case "cashfree":
        return new CashfreeGateway(decryptedConfig);
      case "payu":
        return new PayUGateway(decryptedConfig);
      default:
        throw new Error(`Gateway strategy '${config.gateway_name}' is not supported yet.`);
    }
  }
}
