import sql from '../db.js';
import { sendEmail } from '../emailService.js';
import {
  dispatchPaymentInAppNotification,
  dispatchPlotRegistryInAppNotification,
  dispatchBookingCancellationInAppNotification
} from './inAppNotification.service.js';
import {
  generateEmiReceiptEmailHtml,
  generatePaymentRejectionEmailHtml,
  generateEmiDueReminderEmailHtml,
  generatePlotSoldRegistryEmailHtml,
  generateBookingCancellationEmailHtml,
} from './phase3EmailTemplates.js';

// Cooldown map to prevent accidental duplicate transmissions (5-minute cooldown)
const sentCache = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;

function cleanOldCache() {
  const now = Date.now();
  for (const [key, time] of sentCache.entries()) {
    if (now - time > COOLDOWN_MS) {
      sentCache.delete(key);
    }
  }
}

function getCacheKey(category, id, email) {
  return `${category}:${String(id).trim()}:${String(email || '').toLowerCase().trim()}`;
}

function isDuplicate(category, id, email) {
  cleanOldCache();
  const key = getCacheKey(category, id, email);
  const last = sentCache.get(key);
  if (last && Date.now() - last < COOLDOWN_MS) {
    return true;
  }
  return false;
}

function markSent(category, id, email) {
  sentCache.set(getCacheKey(category, id, email), Date.now());
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

// ─────────────────────────────────────────────────────────────
// 1. PAYMENT RECEIPT NOTIFICATION
// ─────────────────────────────────────────────────────────────

export async function notifyPaymentReceipt(paymentId, details = {}) {
  try {
    let email = (details.customerEmail || details.email || '').trim().toLowerCase();
    let name = details.customerName || details.customer_name || 'Valued Customer';
    let receiptNo = details.receiptNo || details.receipt_no || `REC-${paymentId}`;
    let paymentSerial = details.paymentSerial || details.payment_serial || `TXN-${paymentId}`;
    let plotNumber = details.plotNumber || details.plot_no || details.plot_number || '—';
    let siteName = details.siteName || details.site_name || 'MMR Project';
    let installmentNo = details.installmentNo || details.installment_no || null;
    let amountPaid = Number(details.amountPaid || details.paid_amount || details.gross_amount || 0);
    let paymentMode = details.paymentMode || details.payment_mode || 'Online';
    let paymentDate = details.paymentDate || details.payment_date || new Date();
    let remainingBalance = details.remainingBalance ?? null;
    let nextDueDate = details.nextDueDate ?? null;
    let verifiedBy = details.verifiedBy || 'Finance Desk';
    let receiptUrl = details.receiptUrl || null;

    if (paymentId && (!email || !name || amountPaid <= 0)) {
      try {
        const [ledger] = await sql`
          SELECT pl.*, 
                 b.plot_id, b.user_id AS booking_user_id,
                 p.plot_number, s.site_name,
                 u.full_name AS user_name, u.email AS user_email,
                 r.receipt_no
          FROM payment_ledger pl
          LEFT JOIN bookings b ON b.booking_id = pl.booking_id
          LEFT JOIN plots p ON p.plot_id = b.plot_id
          LEFT JOIN sites s ON s.site_id = p.site_id
          LEFT JOIN users u ON u.user_id = b.user_id
          LEFT JOIN receipts r ON r.payment_ledger_id = pl.payment_id
          WHERE pl.payment_id = ${Number(paymentId)}
          LIMIT 1
        `;

        if (ledger) {
          if (!email && ledger.user_email) email = ledger.user_email.trim().toLowerCase();
          if (!name && ledger.user_name) name = ledger.user_name;
          if (ledger.plot_number) plotNumber = ledger.plot_number;
          if (ledger.site_name) siteName = ledger.site_name;
          if (ledger.receipt_no) receiptNo = ledger.receipt_no;
          if (ledger.payment_serial) paymentSerial = ledger.payment_serial;
          if (amountPaid <= 0 && ledger.gross_amount) amountPaid = Number(ledger.gross_amount);
          if (ledger.payment_mode) paymentMode = ledger.payment_mode;
          if (ledger.payment_date) paymentDate = ledger.payment_date;
        }
      } catch (_) {}
    }

    if (!isValidEmail(email)) {
      console.warn(`[Phase3Email] Cannot send receipt for payment #${paymentId}: No valid email found.`);
      return { success: false, skipped: true, reason: 'invalid_email' };
    }

    if (isDuplicate('payment_receipt', paymentId || receiptNo, email)) {
      return { success: true, skipped: true, reason: 'duplicate_cooldown' };
    }

    const html = generateEmiReceiptEmailHtml({
      customerName: name,
      receiptNo,
      paymentSerial,
      plotNumber,
      siteName,
      installmentNo,
      amountPaid,
      paymentMode,
      paymentDate,
      remainingBalance,
      nextDueDate,
      verifiedBy,
      receiptUrl,
    });

    await sendEmail({
      to: email,
      subject: `MMR Constructions - Official Payment Receipt (${receiptNo})`,
      html,
    });

    markSent('payment_receipt', paymentId || receiptNo, email);
    console.log(`[Phase3Email] Payment receipt email sent to ${email} for receipt #${receiptNo}`);

    return { success: true };
  } catch (err) {
    console.error('[Phase3Email] notifyPaymentReceipt error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 2. PAYMENT REJECTION NOTIFICATION
// ─────────────────────────────────────────────────────────────

export async function notifyPaymentRejection(paymentId, details = {}) {
  try {
    let email = (details.customerEmail || details.email || '').trim().toLowerCase();
    let name = details.customerName || details.customer_name || 'Valued Customer';
    let paymentSerial = details.paymentSerial || details.payment_serial || `TXN-${paymentId}`;
    let plotNumber = details.plotNumber || details.plot_no || '—';
    let siteName = details.siteName || details.site_name || 'MMR Project';
    let amount = Number(details.amount || details.gross_amount || 0);
    let rejectionReason = details.rejectionReason || details.rejection_reason || 'Payment verification could not be completed.';
    let paymentDate = details.paymentDate || details.payment_date || new Date();

    if (paymentId && (!email || !name)) {
      try {
        const [ledger] = await sql`
          SELECT pl.*, b.plot_id, p.plot_number, s.site_name, u.full_name AS user_name, u.email AS user_email
          FROM payment_ledger pl
          LEFT JOIN bookings b ON b.booking_id = pl.booking_id
          LEFT JOIN plots p ON p.plot_id = b.plot_id
          LEFT JOIN sites s ON s.site_id = p.site_id
          LEFT JOIN users u ON u.user_id = b.user_id
          WHERE pl.payment_id = ${Number(paymentId)}
          LIMIT 1
        `;
        if (ledger) {
          if (!email && ledger.user_email) email = ledger.user_email.trim().toLowerCase();
          if (!name && ledger.user_name) name = ledger.user_name;
          if (ledger.plot_number) plotNumber = ledger.plot_number;
          if (ledger.site_name) siteName = ledger.site_name;
          if (ledger.payment_serial) paymentSerial = ledger.payment_serial;
          if (amount <= 0 && ledger.gross_amount) amount = Number(ledger.gross_amount);
        }
      } catch (_) {}
    }

    if (!isValidEmail(email)) {
      console.warn(`[Phase3Email] Cannot send payment rejection for payment #${paymentId}: No valid email found.`);
      return { success: false, skipped: true, reason: 'invalid_email' };
    }

    if (isDuplicate('payment_rejected', paymentId, email)) {
      return { success: true, skipped: true, reason: 'duplicate_cooldown' };
    }

    const html = generatePaymentRejectionEmailHtml({
      customerName: name,
      paymentSerial,
      plotNumber,
      siteName,
      amount,
      rejectionReason,
      paymentDate,
    });

    await sendEmail({
      to: email,
      subject: `MMR Constructions - Payment Verification Notice (${paymentSerial})`,
      html,
    });

    markSent('payment_rejected', paymentId, email);
    console.log(`[Phase3Email] Payment rejection email sent to ${email}`);

    return { success: true };
  } catch (err) {
    console.error('[Phase3Email] notifyPaymentRejection error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 3. UPCOMING EMI DUE REMINDER
// ─────────────────────────────────────────────────────────────

export async function notifyEmiDueReminder(bookingId, details = {}) {
  try {
    let email = (details.customerEmail || details.email || '').trim().toLowerCase();
    let name = details.customerName || details.full_name || 'Valued Customer';
    let plotNumber = details.plotNumber || details.plot_no || '—';
    let siteName = details.siteName || details.site_name || 'MMR Project';
    let installmentNo = details.installmentNo || details.installment_no || 1;
    let emiAmount = Number(details.emiAmount || details.emi_amount || 0);
    let dueDate = details.dueDate || details.due_date || new Date();
    let payOnlineUrl = details.payOnlineUrl || 'https://mmrconstructions.in/customer/dashboard';

    if (bookingId && (!email || !name)) {
      try {
        const [b] = await sql`
          SELECT b.*, u.full_name, u.email, p.plot_number, s.site_name
          FROM bookings b
          JOIN users u ON u.user_id = b.user_id
          JOIN plots p ON p.plot_id = b.plot_id
          JOIN sites s ON s.site_id = p.site_id
          WHERE b.booking_id = ${Number(bookingId)}
          LIMIT 1
        `;
        if (b) {
          if (!email && b.email) email = b.email.trim().toLowerCase();
          if (!name && b.full_name) name = b.full_name;
          if (b.plot_number) plotNumber = b.plot_number;
          if (b.site_name) siteName = b.site_name;
        }
      } catch (_) {}
    }

    if (!isValidEmail(email)) {
      console.warn(`[Phase3Email] Cannot send EMI reminder for booking #${bookingId}: No valid email found.`);
      return { success: false, skipped: true, reason: 'invalid_email' };
    }

    if (isDuplicate(`emi_reminder_${installmentNo}`, bookingId, email)) {
      return { success: true, skipped: true, reason: 'duplicate_cooldown' };
    }

    const html = generateEmiDueReminderEmailHtml({
      customerName: name,
      plotNumber,
      siteName,
      installmentNo,
      emiAmount,
      dueDate,
      payOnlineUrl,
    });

    await sendEmail({
      to: email,
      subject: `MMR Constructions - Upcoming EMI Due Notice (Plot ${plotNumber})`,
      html,
    });

    markSent(`emi_reminder_${installmentNo}`, bookingId, email);
    console.log(`[Phase3Email] EMI reminder email sent to ${email} for Plot ${plotNumber}`);

    return { success: true };
  } catch (err) {
    console.error('[Phase3Email] notifyEmiDueReminder error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 4. PLOT REGISTRY & DEED COMPLETE (MARK SOLD)
// ─────────────────────────────────────────────────────────────

export async function notifyPlotRegistryComplete(bookingId, details = {}) {
  try {
    let email = (details.customerEmail || details.email || '').trim().toLowerCase();
    let name = details.customerName || details.full_name || 'Valued Customer';
    let plotNumber = details.plotNumber || details.plot_number || '—';
    let siteName = details.siteName || details.site_name || 'MMR Project';
    let registryNo = details.registryNo || details.registry_no || 'Recorded';
    let registryDate = details.registryDate || details.registry_date || new Date();
    let possessionDate = details.possessionDate || details.possession_date || null;
    let finalSoldPrice = Number(details.finalSoldPrice || details.final_sold_price || 0);

    if (bookingId && (!email || !name)) {
      try {
        const [b] = await sql`
          SELECT b.*, u.full_name, u.email, p.plot_number, p.sold_price, s.site_name
          FROM bookings b
          JOIN users u ON u.user_id = b.user_id
          JOIN plots p ON p.plot_id = b.plot_id
          JOIN sites s ON s.site_id = p.site_id
          WHERE b.booking_id = ${Number(bookingId)}
          LIMIT 1
        `;
        if (b) {
          if (!email && b.email) email = b.email.trim().toLowerCase();
          if (!name && b.full_name) name = b.full_name;
          if (b.plot_number) plotNumber = b.plot_number;
          if (b.site_name) siteName = b.site_name;
          if (finalSoldPrice <= 0 && b.sold_price) finalSoldPrice = Number(b.sold_price);
        }
      } catch (_) {}
    }

    if (!isValidEmail(email)) {
      console.warn(`[Phase3Email] Cannot send plot sold email for booking #${bookingId}: No valid email found.`);
      return { success: false, skipped: true, reason: 'invalid_email' };
    }

    if (isDuplicate('plot_registry_sold', bookingId, email)) {
      return { success: true, skipped: true, reason: 'duplicate_cooldown' };
    }

    const html = generatePlotSoldRegistryEmailHtml({
      customerName: name,
      plotNumber,
      siteName,
      registryNo,
      registryDate,
      possessionDate,
      finalSoldPrice,
    });

    await sendEmail({
      to: email,
      subject: `MMR Constructions - Plot Ownership Deed Complete (Plot ${plotNumber})`,
      html,
    });

    markSent('plot_registry_sold', bookingId, email);
    console.log(`[Phase3Email] Plot deed complete email sent to ${email} for Plot ${plotNumber}`);

    return { success: true };
  } catch (err) {
    console.error('[Phase3Email] notifyPlotRegistryComplete error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 5. PLOT BOOKING CANCELLED & REFUND DUE
// ─────────────────────────────────────────────────────────────

export async function notifyBookingCancelled(bookingId, details = {}) {
  try {
    let email = (details.customerEmail || details.email || '').trim().toLowerCase();
    let name = details.customerName || details.full_name || 'Valued Customer';
    let bookingSerial = details.bookingSerial || details.booking_serial || `MMR-${bookingId}`;
    let plotNumber = details.plotNumber || details.plot_number || '—';
    let siteName = details.siteName || details.site_name || 'MMR Project';
    let reason = details.reason || details.cancellation_reason || 'Cancelled by administration';
    let refundDue = details.refundDue ?? true;

    if (bookingId && (!email || !name)) {
      try {
        const [b] = await sql`
          SELECT b.*, u.full_name, u.email, p.plot_number, s.site_name
          FROM bookings b
          JOIN users u ON u.user_id = b.user_id
          LEFT JOIN plots p ON p.plot_id = b.plot_id
          LEFT JOIN sites s ON s.site_id = p.site_id
          WHERE b.booking_id = ${Number(bookingId)}
          LIMIT 1
        `;
        if (b) {
          if (!email && b.email) email = b.email.trim().toLowerCase();
          if (!name && b.full_name) name = b.full_name;
          if (b.plot_number) plotNumber = b.plot_number;
          if (b.site_name) siteName = b.site_name;
          if (b.booking_serial) bookingSerial = b.booking_serial;
        }
      } catch (_) {}
    }

    if (!isValidEmail(email)) {
      console.warn(`[Phase3Email] Cannot send cancellation email for booking #${bookingId}: No valid email found.`);
      return { success: false, skipped: true, reason: 'invalid_email' };
    }

    if (isDuplicate('booking_cancelled_email', bookingId, email)) {
      return { success: true, skipped: true, reason: 'duplicate_cooldown' };
    }

    const html = generateBookingCancellationEmailHtml({
      customerName: name,
      bookingSerial,
      plotNumber,
      siteName,
      reason,
      refundDue,
    });

    await sendEmail({
      to: email,
      subject: `MMR Constructions - Booking Cancellation Notice (${bookingSerial})`,
      html,
    });

    markSent('booking_cancelled_email', bookingId, email);
    console.log(`[Phase3Email] Booking cancellation email sent to ${email} for ${bookingSerial}`);

    return { success: true };
  } catch (err) {
    console.error('[Phase3Email] notifyBookingCancelled error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// NON-BLOCKING ASYNC TRIGGER DELEGATORS
// ─────────────────────────────────────────────────────────────

export function triggerPaymentReceiptEmailAsync(paymentId, details = {}) {
  setImmediate(async () => {
    try {
      await notifyPaymentReceipt(paymentId, details);
    } catch (err) {
      console.warn('[Phase3Email] Async payment receipt email error:', err.message);
    }
  });
}

export function triggerPaymentRejectionEmailAsync(paymentId, details = {}) {
  setImmediate(async () => {
    try {
      await notifyPaymentRejection(paymentId, details);
    } catch (err) {
      console.warn('[Phase3Email] Async payment rejection email error:', err.message);
    }
  });
}

export function triggerEmiDueReminderEmailAsync(bookingId, details = {}) {
  setImmediate(async () => {
    try {
      await notifyEmiDueReminder(bookingId, details);
    } catch (err) {
      console.warn('[Phase3Email] Async EMI reminder email error:', err.message);
    }
  });
}

export function triggerPlotRegistryEmailAsync(bookingId, details = {}) {
  setImmediate(async () => {
    try {
      await notifyPlotRegistryComplete(bookingId, details);
    } catch (err) {
      console.warn('[Phase3Email] Async plot registry email error:', err.message);
    }
  });
}

export function triggerBookingCancelledEmailAsync(bookingId, details = {}) {
  setImmediate(async () => {
    try {
      await notifyBookingCancelled(bookingId, details);
    } catch (err) {
      console.warn('[Phase3Email] Async booking cancelled email error:', err.message);
    }
  });
}

