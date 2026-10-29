import sql from '../db.js';
import { sendEmail } from '../emailService.js';
import {
  dispatchBookingInAppNotification,
  dispatchWithdrawalInAppNotification,
  dispatchCommissionReleaseInAppNotification
} from './inAppNotification.service.js';
import {
  generatePlotBookingCustomerEmailHtml,
  generatePlotBookingTeamMemberEmailHtml,
  generatePlotBookingAssociateEmailHtml,
  generatePlotBookingSelfPurchaseEmailHtml,
  generateCommissionSettlementEmailHtml,
  generateWithdrawalRequestUserEmailHtml,
  generateWithdrawalRequestAdminEmailHtml,
  generateWithdrawalReleasedEmailHtml,
  generateWithdrawalRejectedEmailHtml,
} from './phase1EmailTemplates.js';

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

async function getAdminEmail() {
  if (process.env.ADMIN_NOTIFICATION_EMAIL && isValidEmail(process.env.ADMIN_NOTIFICATION_EMAIL)) {
    return process.env.ADMIN_NOTIFICATION_EMAIL.trim();
  }

  try {
    const rows = await sql`
      SELECT email FROM users 
      WHERE (is_admin = TRUE OR user_type IN ('Admin', 'SuperAdmin')) 
        AND email IS NOT NULL AND email <> ''
      ORDER BY user_id ASC LIMIT 1
    `;
    if (rows && rows.length > 0 && isValidEmail(rows[0].email)) {
      return rows[0].email.trim();
    }
  } catch (_) {}

  return process.env.SMTP_USER || 'admin@mmrconstructions.in';
}

// ─────────────────────────────────────────────────────────────
// 1. PLOT BOOKING MULTI-PARTY NOTIFICATIONS
// ─────────────────────────────────────────────────────────────

export async function sendPlotBookingNotifications(bookingId, customBookingData = {}) {
  try {
    let bookingRow = null;
    let buyerRow = null;
    let sellerRow = null;
    let associateRow = null;

    if (bookingId) {
      try {
        const rows = await sql`
          SELECT b.*, 
                 u.full_name AS buyer_name, u.email AS buyer_email, u.mobile_no AS buyer_mobile, u.user_type AS buyer_role,
                 p.plot_number, p.plot_area, p.base_price AS plot_base_price,
                 s.site_name
          FROM bookings b
          LEFT JOIN users u ON u.user_id = b.user_id
          LEFT JOIN plots p ON p.plot_id = b.plot_id
          LEFT JOIN sites s ON s.site_id = p.site_id
          WHERE b.booking_id = ${Number(bookingId)}
          LIMIT 1
        `;
        if (rows && rows.length > 0) {
          bookingRow = rows[0];
          buyerRow = {
            name: bookingRow.buyer_name,
            email: bookingRow.buyer_email,
            mobile: bookingRow.buyer_mobile,
            role: bookingRow.buyer_role,
          };
        }
      } catch (dbErr) {
        console.warn('[BusinessEmail] Could not query booking from DB:', dbErr.message);
      }
    }

    const mergedBooking = {
      ...(bookingRow || {}),
      ...customBookingData,
    };

    const buyerName = mergedBooking.buyer_name || mergedBooking.customer_name || customBookingData.customerName || 'Valued Customer';
    const buyerEmail = (mergedBooking.buyer_email || mergedBooking.email || customBookingData.customerEmail || '').trim().toLowerCase();
    const buyerRole = (mergedBooking.buyer_role || customBookingData.buyerRole || 'Customer').trim();
    const bookingSerial = mergedBooking.booking_serial || `MMR-${mergedBooking.booking_id || bookingId || 'PENDING'}`;
    const plotNumber = mergedBooking.plot_number || customBookingData.plotNumber || '—';
    const plotArea = mergedBooking.plot_area || customBookingData.plotArea || '—';
    const siteName = mergedBooking.site_name || customBookingData.siteName || 'MMR Project';
    const basePrice = Number(mergedBooking.plot_base_price || mergedBooking.base_price || customBookingData.basePrice || 0);
    const advanceAmount = Number(mergedBooking.advance_amount || mergedBooking.required_booking_amount || customBookingData.advanceAmount || 0);
    const remainingBalance = Math.max(0, basePrice - advanceAmount);
    const paymentMethod = mergedBooking.payment_method || customBookingData.paymentMethod || 'Online';
    const bookingDate = mergedBooking.created_at || new Date();

    // Check if Self-Purchase:
    // Either buyer_type === 'SELF' or buyer is Team Member/Associate buying for self
    const isSelfPurchase = Boolean(
      mergedBooking.buyer_type === 'SELF' ||
      mergedBooking.is_self_purchase === true ||
      ((buyerRole === 'Team Member' || buyerRole === 'Associate') &&
       (!mergedBooking.sold_by_user_id || Number(mergedBooking.sold_by_user_id) === Number(mergedBooking.user_id)))
    );

    // ─────────────────────────────────────────────
    // CASE 1: Self-Purchase Booking (Single Email)
    // ─────────────────────────────────────────────
    if (isSelfPurchase) {
      if (isValidEmail(buyerEmail)) {
        if (!isDuplicate('plot_self_purchase', bookingId || bookingSerial, buyerEmail)) {
          const html = generatePlotBookingSelfPurchaseEmailHtml({
            buyerName,
            role: buyerRole,
            bookingSerial,
            plotNumber,
            plotArea,
            siteName,
            basePrice,
            advanceAmount,
            remainingBalance,
            paymentMethod,
            bookingDate,
          });
          await sendEmail({
            to: buyerEmail,
            subject: `MMR Constructions - Self-Purchase Booking Confirmed (${bookingSerial})`,
            html,
          });
          markSent('plot_self_purchase', bookingId || bookingSerial, buyerEmail);
          console.log(`[BusinessEmail] Self-purchase booking confirmation sent to ${buyerEmail}`);
        }
      }
      return { success: true, type: 'self_purchase' };
    }

    // ─────────────────────────────────────────────
    // CASE 2: Customer Booking (Multi-Party Email)
    // ─────────────────────────────────────────────

    // Fetch Seller (Team Member) & Associate details if available
    const soldByUserId = mergedBooking.sold_by_user_id || customBookingData.soldByUserId;
    const associateUserId = mergedBooking.associate_user_id || customBookingData.associateUserId;

    if (soldByUserId) {
      try {
        const [tm] = await sql`
          SELECT user_id, full_name, email, mobile_no, user_type 
          FROM users WHERE user_id = ${Number(soldByUserId)} LIMIT 1
        `;
        if (tm) sellerRow = tm;
      } catch (_) {}
    }

    if (associateUserId && Number(associateUserId) !== Number(soldByUserId)) {
      try {
        const [asc] = await sql`
          SELECT user_id, full_name, email, mobile_no, user_type 
          FROM users WHERE user_id = ${Number(associateUserId)} LIMIT 1
        `;
        if (asc) associateRow = asc;
      } catch (_) {}
    }

    const teamMemberName = sellerRow?.full_name || customBookingData.teamMemberName || null;
    const teamMemberEmail = (sellerRow?.email || customBookingData.teamMemberEmail || '').trim().toLowerCase();
    const teamMemberContact = sellerRow?.mobile_no || customBookingData.teamMemberContact || null;
    const associateName = associateRow?.full_name || customBookingData.associateName || null;
    const associateEmail = (associateRow?.email || customBookingData.associateEmail || '').trim().toLowerCase();

    // 1. Send Email to Customer
    if (isValidEmail(buyerEmail)) {
      if (!isDuplicate('plot_customer', bookingId || bookingSerial, buyerEmail)) {
        const customerHtml = generatePlotBookingCustomerEmailHtml({
          bookingSerial,
          customerName: buyerName,
          plotNumber,
          plotArea,
          siteName,
          basePrice,
          advanceAmount,
          remainingBalance,
          paymentMethod,
          paymentStatus: 'Payment Confirmed',
          bookingDate,
          teamMemberName,
          teamMemberContact,
          associateName,
        });
        await sendEmail({
          to: buyerEmail,
          subject: `MMR Constructions - Plot Booking Confirmation (${bookingSerial})`,
          html: customerHtml,
        });
        markSent('plot_customer', bookingId || bookingSerial, buyerEmail);
        console.log(`[BusinessEmail] Customer plot booking email sent to ${buyerEmail}`);
      }
    }

    // 2. Send Email to Team Member (if customer is linked to a team member)
    if (isValidEmail(teamMemberEmail)) {
      if (!isDuplicate('plot_team_member', bookingId || bookingSerial, teamMemberEmail)) {
        const tmHtml = generatePlotBookingTeamMemberEmailHtml({
          teamMemberName: teamMemberName || 'Team Member',
          customerName: buyerName,
          bookingSerial,
          plotNumber,
          siteName,
          advanceAmount,
          basePrice,
          bookingDate,
        });
        await sendEmail({
          to: teamMemberEmail,
          subject: `MMR Constructions - New Customer Booking Attributed To You (${bookingSerial})`,
          html: tmHtml,
        });
        markSent('plot_team_member', bookingId || bookingSerial, teamMemberEmail);
        console.log(`[BusinessEmail] Team member booking notification sent to ${teamMemberEmail}`);
      }
    }

    // 3. Send Email to Associate Partner (if customer is linked in their network)
    if (isValidEmail(associateEmail)) {
      if (!isDuplicate('plot_associate', bookingId || bookingSerial, associateEmail)) {
        const ascHtml = generatePlotBookingAssociateEmailHtml({
          associateName: associateName || 'Associate Partner',
          teamMemberName: teamMemberName || 'Team Member',
          customerName: buyerName,
          bookingSerial,
          plotNumber,
          siteName,
          advanceAmount,
          basePrice,
          bookingDate,
        });
        await sendEmail({
          to: associateEmail,
          subject: `MMR Constructions - New Plot Booking in Your Associate Network (${bookingSerial})`,
          html: ascHtml,
        });
        markSent('plot_associate', bookingId || bookingSerial, associateEmail);
        console.log(`[BusinessEmail] Associate hierarchy booking notification sent to ${associateEmail}`);
      }
    }

    return { success: true, type: 'customer_multi_party' };
  } catch (err) {
    console.error('[BusinessEmail] sendPlotBookingNotifications encountered error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 2. COMMISSION SETTLEMENT RELEASE NOTIFICATIONS
// ─────────────────────────────────────────────────────────────

export async function sendCommissionSettlementNotifications(bookingId, settlementData = {}, recipients = []) {
  try {
    const {
      settlementReference = 'MMR-STL-RELEASE',
      bookingSerial = '—',
      plotNumber = '—',
      siteName = 'MMR Project',
      customerName = 'Customer',
      adminName = 'Finance Operations',
      releasedAt = new Date(),
    } = settlementData;

    if (!Array.isArray(recipients) || recipients.length === 0) {
      console.log('[BusinessEmail] No recipients specified for commission settlement notification.');
      return { success: false, skipped: true, reason: 'no_recipients' };
    }

    for (const rec of recipients) {
      const userId = rec.user_id;
      const amount = Number(rec.amount || 0);
      if (!userId || amount <= 0) continue;

      let email = (rec.email || '').trim().toLowerCase();
      let name = rec.name || rec.full_name || 'Member';
      let role = rec.user_type || rec.role || 'Partner';
      let availableBalance = amount;

      // Fetch user details & wallet balance if email missing
      try {
        const [u] = await sql`
          SELECT full_name, email, user_type 
          FROM users WHERE user_id = ${Number(userId)} LIMIT 1
        `;
        if (u) {
          if (!email && u.email) email = u.email.trim().toLowerCase();
          if (u.full_name) name = u.full_name;
          if (u.user_type) role = u.user_type;
        }

        const [w] = await sql`
          SELECT available_balance 
          FROM user_wallets WHERE user_id = ${Number(userId)} LIMIT 1
        `;
        if (w) availableBalance = Number(w.available_balance || 0);
      } catch (_) {}

      if (!isValidEmail(email)) {
        console.warn(`[BusinessEmail] Cannot send commission email to user #${userId}: No valid email found.`);
        continue;
      }

      if (isDuplicate('commission_settlement', `${settlementReference}:${userId}`, email)) {
        continue;
      }

      const html = generateCommissionSettlementEmailHtml({
        recipientName: name,
        userRole: role,
        settlementReference,
        bookingSerial,
        plotNumber,
        siteName,
        customerName,
        commissionAmount: amount,
        updatedAvailableBalance: availableBalance,
        adminName,
        releasedAt,
      });

      await sendEmail({
        to: email,
        subject: `MMR Constructions - Commission Released (${settlementReference})`,
        html,
      });

      markSent('commission_settlement', `${settlementReference}:${userId}`, email);
      console.log(`[BusinessEmail] Commission release email sent to ${email} for ₹${amount}`);
    }

    return { success: true };
  } catch (err) {
    console.error('[BusinessEmail] sendCommissionSettlementNotifications error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 3. WITHDRAWAL REQUEST & STATUS NOTIFICATIONS
// ─────────────────────────────────────────────────────────────

export async function sendWithdrawalRequestNotifications(withdrawalId, data = {}) {
  try {
    let email = (data.userEmail || data.email || '').trim().toLowerCase();
    let name = data.userName || data.full_name || 'Member';
    let role = data.userRole || data.role || 'Associate';
    const amount = Number(data.amount || 0);
    const bankName = data.bankName || data.bank_name || 'Bank Account';
    const accountNumber = data.accountNumber || data.bank_account_number || data.account_number || '—';
    const ifscCode = data.ifscCode || data.ifsc_code || '—';
    const upiId = data.upiId || data.upi_id || null;
    const requestedAt = data.requestedAt || new Date();

    // Fetch user details from DB if needed
    if ((!email || !name) && data.user_id) {
      try {
        const [u] = await sql`
          SELECT full_name, email, user_type FROM users 
          WHERE user_id = ${Number(data.user_id)} LIMIT 1
        `;
        if (u) {
          if (!email && u.email) email = u.email.trim().toLowerCase();
          if (!name && u.full_name) name = u.full_name;
          if (u.user_type) role = u.user_type;
        }
      } catch (_) {}
    }

    // 1. Send User Acknowledgment Email
    if (isValidEmail(email)) {
      if (!isDuplicate('withdrawal_request_user', withdrawalId, email)) {
        const userHtml = generateWithdrawalRequestUserEmailHtml({
          userName: name,
          userRole: role,
          withdrawalId,
          amount,
          bankName,
          accountNumber,
          ifscCode,
          requestedAt,
        });
        await sendEmail({
          to: email,
          subject: `MMR Constructions - Withdrawal Request Received (#${withdrawalId})`,
          html: userHtml,
        });
        markSent('withdrawal_request_user', withdrawalId, email);
        console.log(`[BusinessEmail] Withdrawal acknowledgment sent to user ${email}`);
      }
    }

    // 2. Send Admin Alert Email
    const adminEmail = await getAdminEmail();
    if (isValidEmail(adminEmail)) {
      if (!isDuplicate('withdrawal_request_admin', withdrawalId, adminEmail)) {
        const adminHtml = generateWithdrawalRequestAdminEmailHtml({
          userName: name,
          userEmail: email || '—',
          userRole: role,
          userId: data.user_id || '—',
          withdrawalId,
          amount,
          bankName,
          accountNumber,
          ifscCode,
          upiId,
          requestedAt,
        });
        await sendEmail({
          to: adminEmail,
          subject: `[Admin Alert] New Withdrawal Request: ₹${amount.toLocaleString('en-IN')} - ${name}`,
          html: adminHtml,
        });
        markSent('withdrawal_request_admin', withdrawalId, adminEmail);
        console.log(`[BusinessEmail] Withdrawal admin alert sent to ${adminEmail}`);
      }
    }

    return { success: true };
  } catch (err) {
    console.error('[BusinessEmail] sendWithdrawalRequestNotifications error:', err.message);
    return { success: false, error: err.message };
  }
}

export async function sendWithdrawalStatusNotification(withdrawalId, data = {}, status = 'released') {
  try {
    let email = (data.userEmail || data.email || '').trim().toLowerCase();
    let name = data.userName || data.full_name || 'Member';
    let role = data.userRole || data.role || 'Associate';
    const amount = Number(data.amount || 0);
    const bankName = data.bankName || data.bank_name || 'Bank Account';
    const accountNumber = data.accountNumber || data.bank_account_number || data.account_number || '—';
    const payoutReference = data.payoutReference || data.payout_reference_id || `REF-MAN-${Date.now()}`;
    const rejectionReason = data.rejectionReason || data.rejection_reason || data.admin_remarks || 'Administrative review criteria not met.';
    const actionDate = new Date();

    if ((!email || !name) && data.user_id) {
      try {
        const [u] = await sql`
          SELECT full_name, email, user_type FROM users 
          WHERE user_id = ${Number(data.user_id)} LIMIT 1
        `;
        if (u) {
          if (!email && u.email) email = u.email.trim().toLowerCase();
          if (!name && u.full_name) name = u.full_name;
          if (u.user_type) role = u.user_type;
        }
      } catch (_) {}
    }

    if (!isValidEmail(email)) {
      console.warn(`[BusinessEmail] Cannot send withdrawal status to user #${data.user_id}: No valid email found.`);
      return { success: false, skipped: true, reason: 'no_valid_email' };
    }

    const normStatus = String(status).toLowerCase().trim();

    if (normStatus === 'released' || normStatus === 'approved') {
      if (!isDuplicate('withdrawal_released', withdrawalId, email)) {
        const html = generateWithdrawalReleasedEmailHtml({
          userName: name,
          userRole: role,
          withdrawalId,
          amount,
          payoutReference,
          bankName,
          accountNumber,
          releasedAt: actionDate,
        });
        await sendEmail({
          to: email,
          subject: `MMR Constructions - Withdrawal Payout Released (#${withdrawalId})`,
          html,
        });
        markSent('withdrawal_released', withdrawalId, email);
        console.log(`[BusinessEmail] Withdrawal release email sent to ${email}`);
      }
    } else if (normStatus === 'rejected' || normStatus === 'failed') {
      if (!isDuplicate('withdrawal_rejected', withdrawalId, email)) {
        const html = generateWithdrawalRejectedEmailHtml({
          userName: name,
          userRole: role,
          withdrawalId,
          amount,
          rejectionReason,
          rejectedAt: actionDate,
        });
        await sendEmail({
          to: email,
          subject: `MMR Constructions - Withdrawal Request Update (#${withdrawalId})`,
          html,
        });
        markSent('withdrawal_rejected', withdrawalId, email);
        console.log(`[BusinessEmail] Withdrawal rejection email sent to ${email}`);
      }
    }

    return { success: true };
  } catch (err) {
    console.error('[BusinessEmail] sendWithdrawalStatusNotification error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// NON-BLOCKING ASYNC TRIGGER DELEGATORS
// ─────────────────────────────────────────────────────────────

export function triggerPlotBookingEmailsAsync(bookingId, customBookingData = {}) {
  setImmediate(async () => {
    try {
      await sendPlotBookingNotifications(bookingId, customBookingData);
    } catch (err) {
      console.warn('[BusinessEmail] Async plot booking email caught error:', err.message);
    }
  });
}

export function triggerCommissionSettlementEmailsAsync(bookingId, settlementData = {}, recipients = []) {
  setImmediate(async () => {
    try {
      await sendCommissionSettlementNotifications(bookingId, settlementData, recipients);
    } catch (err) {
      console.warn('[BusinessEmail] Async commission settlement email caught error:', err.message);
    }
  });
}

export function triggerWithdrawalRequestEmailsAsync(withdrawalId, data = {}) {
  setImmediate(async () => {
    try {
      await sendWithdrawalRequestNotifications(withdrawalId, data);
    } catch (err) {
      console.warn('[BusinessEmail] Async withdrawal request email caught error:', err.message);
    }
  });
}

export function triggerWithdrawalStatusEmailsAsync(withdrawalId, data = {}, status = 'released') {
  setImmediate(async () => {
    try {
      await sendWithdrawalStatusNotification(withdrawalId, data, status);
    } catch (err) {
      console.warn('[BusinessEmail] Async withdrawal status email caught error:', err.message);
    }
  });
}

