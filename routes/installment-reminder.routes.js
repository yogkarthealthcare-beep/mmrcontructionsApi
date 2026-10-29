import express from "express";
import sql from "../db.js";
import {
  processDueInstallmentReminders,
  ensureInstallmentReminderSchema,
} from "../services/installmentReminder.service.js";

const router = express.Router();

/**
 * POST /api/admin/installments/run-due-reminders
 * Triggers automated sweep of all pending/due installments for the current cycle.
 */
router.post("/admin/installments/run-due-reminders", async (req, res) => {
  try {
    const forceAll = String(req.body?.forceAll || req.query.force || "false").toLowerCase() === "true";
    const result = await processDueInstallmentReminders({ forceAll });
    return res.status(200).json({
      success: true,
      message: `Installment reminder sweep completed. Sent: ${result.sentCount}, Skipped: ${result.skippedCount}, Errors: ${result.errorCount}`,
      data: result,
    });
  } catch (error) {
    console.error("[InstallmentReminder Route Error]", error);
    return res.status(500).json({
      success: false,
      message: "Failed to run installment reminder sweep: " + error.message,
    });
  }
});

/**
 * GET /api/admin/installments/reminder-logs
 * Retrieves sent reminder history and logs.
 */
router.get("/admin/installments/reminder-logs", async (req, res) => {
  try {
    await ensureInstallmentReminderSchema();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const search = req.query.search ? String(req.query.search).trim() : "";
    const cycle = req.query.cycle ? String(req.query.cycle).trim() : "";

    let rows;
    let totalRow;

    if (search && cycle) {
      const searchPattern = `%${search}%`;
      rows = await sql`
        SELECT * FROM installment_reminder_logs
        WHERE reminder_cycle = ${cycle}
          AND (customer_name ILIKE ${searchPattern} OR customer_email ILIKE ${searchPattern} OR plot_number ILIKE ${searchPattern})
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      [totalRow] = await sql`
        SELECT COUNT(*)::int AS count FROM installment_reminder_logs
        WHERE reminder_cycle = ${cycle}
          AND (customer_name ILIKE ${searchPattern} OR customer_email ILIKE ${searchPattern} OR plot_number ILIKE ${searchPattern})
      `;
    } else if (search) {
      const searchPattern = `%${search}%`;
      rows = await sql`
        SELECT * FROM installment_reminder_logs
        WHERE customer_name ILIKE ${searchPattern} OR customer_email ILIKE ${searchPattern} OR plot_number ILIKE ${searchPattern}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      [totalRow] = await sql`
        SELECT COUNT(*)::int AS count FROM installment_reminder_logs
        WHERE customer_name ILIKE ${searchPattern} OR customer_email ILIKE ${searchPattern} OR plot_number ILIKE ${searchPattern}
      `;
    } else if (cycle) {
      rows = await sql`
        SELECT * FROM installment_reminder_logs
        WHERE reminder_cycle = ${cycle}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      [totalRow] = await sql`
        SELECT COUNT(*)::int AS count FROM installment_reminder_logs
        WHERE reminder_cycle = ${cycle}
      `;
    } else {
      rows = await sql`
        SELECT * FROM installment_reminder_logs
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      [totalRow] = await sql`SELECT COUNT(*)::int AS count FROM installment_reminder_logs`;
    }

    const total = totalRow ? totalRow.count : 0;

    return res.status(200).json({
      success: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("[InstallmentReminder Logs Error]", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load reminder logs: " + error.message,
    });
  }
});

export default router;

