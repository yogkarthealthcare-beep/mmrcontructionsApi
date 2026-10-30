import sql from "../db.js";
import { ensureCustomerApprovalSchema } from "../services/customerApprovalAuthority.service.js";

async function run() {
  console.log("=== ENSURING CUSTOMER APPROVAL HIERARCHY SCHEMA ===");
  try {
    const success = await ensureCustomerApprovalSchema(sql);
    if (success) {
      console.log("✅ Customer approval hierarchy schema is fully verified and ready.");
    } else {
      console.warn("⚠️ Customer approval hierarchy schema returned false.");
    }
  } catch (err) {
    console.error("❌ Error ensuring customer approval hierarchy schema:", err.message);
  } finally {
    process.exit(0);
  }
}

run();

