/**
 * MMR Constructions - Standalone Installment Due Reminder Service
 * 
 * Purpose:
 * Automatically monitors customer plot installments (EMI).
 * On the 1st of every month (and for unpaid/overdue installments),
 * automatically dispatches email reminders to plot buyers.
 * Also alerts the selling associate (commission context) via In-App notification.
 * 
 * Standalone & Resilient:
 * - Runs independently without impacting bookings, payments, or other modules.
 * - Persistent database deduplication prevents spamming customers.
 * - Non-blocking background scheduler with manual on-demand admin trigger.
 */

import sql from "../db.js";
import { sendEmail } from "../emailService.js";
import { generateEmiDueReminderEmailHtml } from "./phase3EmailTemplates.js";

let schedulerStarted = false;
let lastSchedulerRunDay = "";

/**
 * Idempotent Schema Initializer
 */
export async function ensureInstallmentReminderSchema(db = sql) {
  try {
    await db`
      CREATE TABLE IF NOT EXISTS installment_reminder_logs (
        id SERIAL PRIMARY KEY,
        emi_id INTEGER NOT NULL,
        booking_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        customer_name TEXT,
        customer_email TEXT NOT NULL,
        customer_mobile TEXT,
        installment_no INTEGER NOT NULL,
        emi_amount NUMERIC(14,2) NOT NULL,
        due_date DATE NOT NULL,
        plot_number TEXT,
        site_name TEXT,
        reminder_cycle TEXT NOT NULL,
        delivery_channel VARCHAR(30) NOT NULL DEFAULT 'email',
        delivery_status VARCHAR(30) NOT NULL DEFAULT 'Sent',
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await db`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_emi_reminder_cycle 
      ON installment_reminder_logs(emi_id, reminder_cycle, delivery_channel)
    `.catch(() => {});

    await db`
      CREATE INDEX IF NOT EXISTS idx_installment_reminder_booking 
      ON installment_reminder_logs(booking_id, user_id)
    `.catch(() => {});

    console.log("[InstallmentReminder] Schema verified successfully.");
  } catch (err) {
    console.warn("[InstallmentReminder] Schema verification notice:", err.message);
  }
}

/**
 * Validates email string
 */
function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

/**
 * Core Batch Processor for Due Installment Reminders
 */
export async function processDueInstallmentReminders({ forceAll = false } = {}) {
  await ensureInstallmentReminderSchema();

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = String(now.getMonth() + 1).padStart(2, "0");
  const reminderCycle = `${currentYear}-${currentMonth}`; // e.g. "2026-11"

  console.log(`[InstallmentReminder] Starting installment reminder sweep for cycle: ${reminderCycle}...`);

  // Query all active bookings with unpaid EMIs due on or before today
  // or due within the current month
  let candidates = [];
  try {
    candidates = await sql`
      SELECT 
        e.emi_id,
        e.booking_id,
        e.user_id,
        e.installment_no,
        e.due_date,
        e.emi_amount,
        COALESCE(e.paid_amount, 0) AS paid_amount,
        e.emi_status,
        u.full_name AS customer_name,
        u.email AS customer_email,
        u.mobile_no AS customer_mobile,
        p.plot_number,
        s.site_name,
        b.sold_by_user_id,
        assoc.full_name AS associate_name,
        assoc.email AS associate_email
      FROM emi_schedules e
      JOIN bookings b ON b.booking_id = e.booking_id
      JOIN users u ON u.user_id = e.user_id
      JOIN plots p ON p.plot_id = b.plot_id
      JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users assoc ON assoc.user_id = b.sold_by_user_id
      WHERE LOWER(COALESCE(e.emi_status::text, '')) NOT IN ('paid', 'completed')
        AND LOWER(COALESCE(b.booking_status::text, '')) IN ('confirmed', 'active')
        AND (
          e.due_date <= CURRENT_DATE 
          OR TO_CHAR(e.due_date, 'YYYY-MM') <= ${reminderCycle}
        )
      ORDER BY e.due_date ASC, e.installment_no ASC
    `;
  } catch (queryErr) {
    console.error("[InstallmentReminder] Query candidates error:", queryErr.message);
    return {
      success: false,
      error: queryErr.message,
      totalFound: 0,
      sentCount: 0,
      skippedCount: 0,
    };
  }

  const results = {
    cycle: reminderCycle,
    totalFound: candidates.length,
    sentCount: 0,
    skippedCount: 0,
    errorCount: 0,
    details: [],
  };

  for (const item of candidates) {
    const emiId = Number(item.emi_id);
    const email = String(item.customer_email || "").trim().toLowerCase();
    const customerName = item.customer_name || "Valued Customer";
    const plotNumber = item.plot_number || "—";
    const siteName = item.site_name || "MMR Constructions";
    const installmentNo = item.installment_no || 1;
    const emiAmount = Number(item.emi_amount || 0);
    const dueDate = item.due_date ? new Date(item.due_date) : now;

    // 1. Check if reminder already sent for this EMI in this monthly cycle
    if (!forceAll) {
      try {
        const [existing] = await sql`
          SELECT id FROM installment_reminder_logs
          WHERE emi_id = ${emiId}
            AND reminder_cycle = ${reminderCycle}
            AND delivery_channel = 'email'
            AND delivery_status = 'Sent'
          LIMIT 1
        `;
        if (existing) {
          results.skippedCount++;
          results.details.push({
            emiId,
            customerName,
            email,
            status: "skipped_duplicate_cycle",
          });
          continue;
        }
      } catch (_) {}
    }

    // 2. Validate Email
    if (!isValidEmail(email)) {
      results.skippedCount++;
      results.details.push({
        emiId,
        customerName,
        email,
        status: "skipped_invalid_email",
      });
      continue;
    }

    // 3. Dispatch Email
    try {
      const emailHtml = generateEmiDueReminderEmailHtml({
        customerName,
        plotNumber,
        siteName,
        installmentNo,
        emiAmount,
        dueDate,
        payOnlineUrl: "https://mmrconstructions.in/user/emi-history",
      });

      await sendEmail({
        to: email,
        subject: `MMR Constructions - Installment Due Notice: Plot ${plotNumber} (EMI #${installmentNo})`,
        html: emailHtml,
      });

      // 4. Record in persistent log
      await sql`
        INSERT INTO installment_reminder_logs (
          emi_id, booking_id, user_id, customer_name, customer_email, customer_mobile,
          installment_no, emi_amount, due_date, plot_number, site_name,
          reminder_cycle, delivery_channel, delivery_status, created_at
        ) VALUES (
          ${emiId}, ${item.booking_id}, ${item.user_id}, ${customerName}, ${email}, ${item.customer_mobile || null},
          ${installmentNo}, ${emiAmount}, ${dueDate.toISOString().split("T")[0]}, ${plotNumber}, ${siteName},
          ${reminderCycle}, 'email', 'Sent', NOW()
        )
        ON CONFLICT (emi_id, reminder_cycle, delivery_channel)
        DO UPDATE SET delivery_status = 'Sent', created_at = NOW()
      `;

      // 5. Create in-app notification for the customer
      try {
        await sql`
          INSERT INTO notification_log (
            user_id, target_role, title, message, channel, link, is_read, sent_at
          ) VALUES (
            ${item.user_id}, 'User',
            ${`Plot Installment Due Notice - Plot ${plotNumber}`},
            ${`Your monthly installment #${installmentNo} of ₹${emiAmount.toLocaleString('en-IN')} for Plot ${plotNumber} (${siteName}) is due for payment.`},
            'InApp', '/user/emi-history', FALSE, NOW()
          )
        `;
      } catch (_) {}

      // 6. Associate Commission Context Notification (if plot was sold by an Associate)
      if (item.sold_by_user_id) {
        try {
          await sql`
            INSERT INTO notification_log (
              user_id, target_role, title, message, channel, link, is_read, sent_at
            ) VALUES (
              ${item.sold_by_user_id}, 'Associate',
              ${`Customer Installment Due - Plot ${plotNumber}`},
              ${`Monthly installment #${installmentNo} for Plot ${plotNumber} (${siteName}) is pending payment from customer ${customerName}. Follow up to ensure active commission settlement.`},
              'InApp', '/user/team', FALSE, NOW()
            )
          `;
        } catch (_) {}
      }

      results.sentCount++;
      results.details.push({
        emiId,
        customerName,
        email,
        installmentNo,
        plotNumber,
        status: "sent_successfully",
      });

      console.log(`[InstallmentReminder] Successfully sent EMI reminder to ${email} for Plot ${plotNumber} (EMI #${installmentNo})`);
    } catch (dispatchErr) {
      results.errorCount++;
      results.details.push({
        emiId,
        customerName,
        email,
        status: "error",
        error: dispatchErr.message,
      });

      // Log failure in reminder logs
      try {
        await sql`
          INSERT INTO installment_reminder_logs (
            emi_id, booking_id, user_id, customer_name, customer_email, customer_mobile,
            installment_no, emi_amount, due_date, plot_number, site_name,
            reminder_cycle, delivery_channel, delivery_status, error_message, created_at
          ) VALUES (
            ${emiId}, ${item.booking_id}, ${item.user_id}, ${customerName}, ${email}, ${item.customer_mobile || null},
            ${installmentNo}, ${emiAmount}, ${dueDate.toISOString().split("T")[0]}, ${plotNumber}, ${siteName},
            ${reminderCycle}, 'email', 'Failed', ${dispatchErr.message}, NOW()
          )
          ON CONFLICT (emi_id, reminder_cycle, delivery_channel)
          DO UPDATE SET delivery_status = 'Failed', error_message = ${dispatchErr.message}, created_at = NOW()
        `;
      } catch (_) {}

      console.warn(`[InstallmentReminder] Error sending reminder to ${email}:`, dispatchErr.message);
    }
  }

  console.log(`[InstallmentReminder] Finished sweep. Sent: ${results.sentCount}, Skipped: ${results.skippedCount}, Errors: ${results.errorCount}`);
  return { success: true, ...results };
}

/**
 * Starts the resilient daily background scheduler.
 * Runs once every hour, and triggers when the current date has not yet been processed.
 */
export function startInstallmentReminderScheduler() {
  if (schedulerStarted || process.env.NODE_ENV === "test") return;
  schedulerStarted = true;

  console.log("[InstallmentReminder] Background installment reminder scheduler initialized.");

  // Check every hour (3600000 ms)
  const INTERVAL_MS = 60 * 60 * 1000;

  setInterval(async () => {
    try {
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
      const currentHour = now.getHours(); // Local server hour

      // Run daily in the morning window (between 9 AM and 10 AM)
      // or on the 1st day of the month if not yet run today
      if (lastSchedulerRunDay !== todayStr && currentHour >= 9) {
        lastSchedulerRunDay = todayStr;
        console.log(`[InstallmentReminder] Running scheduled reminder sweep for ${todayStr}...`);
        await processDueInstallmentReminders({ forceAll: false });
      }
    } catch (err) {
      console.warn("[InstallmentReminder] Scheduler loop notice:", err.message);
    }
  }, INTERVAL_MS).unref?.();
}

export default {
  ensureInstallmentReminderSchema,
  processDueInstallmentReminders,
  startInstallmentReminderScheduler,
};

