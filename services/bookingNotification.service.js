import sql from '../db.js';
import { sendEmail } from '../emailService.js';

/**
 * Standardized Booking Notification Service
 * Dispatches both in-app notifications (notification_log) and email notifications (nodemailer).
 * Guarantees that email or logging issues will never throw or rollback database transactions.
 */

export async function dispatchBookingNotification(eventType, data = {}) {
  const {
    userId,
    userEmail,
    userName,
    plotNumber,
    siteName,
    bookingId,
    bookingSerial,
    reason,
    queuePosition,
    soldPrice,
    registryNo,
    adminId = null
  } = data;

  let title = '';
  let inAppMessage = '';
  let emailHtml = '';

  const plotLabel = plotNumber ? `Plot ${plotNumber}` : 'Plot';
  const siteLabel = siteName ? `at ${siteName}` : '';
  const customerName = userName || 'Customer';

  switch (eventType) {
    case 'booking_submitted':
      title = 'Plot Booking Received';
      inAppMessage = `Your booking request for ${plotLabel} ${siteLabel} has been received. Our sales team is reviewing your application.`;
      emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #d97706; margin-top: 0;">Plot Booking Application Received</h2>
          <p>Dear <strong>${customerName}</strong>,</p>
          <p>Thank you for booking with MMR Constructions. We have received your booking application for <strong>${plotLabel}</strong> ${siteLabel}.</p>
          <div style="background: #f8fafc; border-left: 4px solid #d97706; padding: 12px 16px; margin: 16px 0;">
            <p style="margin: 4px 0;"><strong>Booking Reference:</strong> ${bookingSerial || bookingId || 'N/A'}</p>
            <p style="margin: 4px 0;"><strong>Status:</strong> Under Admin Review</p>
          </div>
          <p>Our sales management team will verify the advance payment and confirm your allotment shortly.</p>
          <p style="color: #64748b; font-size: 13px; margin-top: 24px;">MMR Constructions — Building Dreams with Trust.</p>
        </div>
      `;
      break;

    case 'booking_confirmed':
      title = 'Plot Booking Confirmed';
      inAppMessage = `Badhaai! Aapki booking for ${plotLabel} ${siteLabel} confirm ho gayi hai. Plot has been allotted to you.`;
      emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #059669; margin-top: 0;">🎉 Booking Confirmed!</h2>
          <p>Dear <strong>${customerName}</strong>,</p>
          <p>Congratulations! Your booking for <strong>${plotLabel}</strong> ${siteLabel} has been successfully verified and confirmed.</p>
          <div style="background: #ecfdf5; border-left: 4px solid #059669; padding: 12px 16px; margin: 16px 0;">
            <p style="margin: 4px 0;"><strong>Booking Reference:</strong> ${bookingSerial || bookingId || 'N/A'}</p>
            <p style="margin: 4px 0;"><strong>Status:</strong> Confirmed &amp; Allotted</p>
          </div>
          <p>You can view your installment schedule and payment receipts directly in your customer portal under "My Plots".</p>
          <p style="color: #64748b; font-size: 13px; margin-top: 24px;">MMR Constructions — Building Dreams with Trust.</p>
        </div>
      `;
      break;

    case 'booking_waitlisted':
      title = 'Plot Booking Waitlisted';
      inAppMessage = `Plot ${plotNumber} has been allotted to another booking. You are on the waitlist (Queue #${queuePosition || 1}). Our team will contact you to transfer or refund.`;
      emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #6366f1; margin-top: 0;">Plot Booking Update: Waitlisted</h2>
          <p>Dear <strong>${customerName}</strong>,</p>
          <p>We are writing to update you regarding your booking application for <strong>${plotLabel}</strong> ${siteLabel}.</p>
          <p>This plot has been allotted to another applicant whose payment was verified first. You have been placed on the priority <strong>Waitlist (Queue Position #${queuePosition || 1})</strong>.</p>
          <div style="background: #eef2ff; border-left: 4px solid #6366f1; padding: 12px 16px; margin: 16px 0;">
            <p style="margin: 4px 0;"><strong>Waitlist Position:</strong> #${queuePosition || 1}</p>
            <p style="margin: 4px 0;"><strong>Next Steps:</strong> Our executive will contact you to transfer your booking to another prime plot or assist with refund options.</p>
          </div>
          <p>If you would like to select another available plot immediately, please visit your portal or contact our support team.</p>
          <p style="color: #64748b; font-size: 13px; margin-top: 24px;">MMR Constructions ERP Desk.</p>
        </div>
      `;
      break;

    case 'booking_promoted':
      title = 'Waitlist Promoted to Active Booking';
      inAppMessage = `Your waitlisted booking for ${plotLabel} ${siteLabel} has been promoted to Active. Please complete payment verification.`;
      emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #0284c7; margin-top: 0;">Waitlist Application Promoted</h2>
          <p>Dear <strong>${customerName}</strong>,</p>
          <p>Great news! Your booking application for <strong>${plotLabel}</strong> ${siteLabel} has been promoted to <strong>Active Application</strong>.</p>
          <p>Our team is now processing your allocation. Please check your customer portal for real-time status.</p>
          <p style="color: #64748b; font-size: 13px; margin-top: 24px;">MMR Constructions — Building Dreams with Trust.</p>
        </div>
      `;
      break;

    case 'plot_available_again':
      title = 'Plot Available Again';
      inAppMessage = `Good news! ${plotLabel} ${siteLabel} is available again. As the first waitlisted applicant, you may proceed with allotment.`;
      emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #059669; margin-top: 0;">Plot Available Again!</h2>
          <p>Dear <strong>${customerName}</strong>,</p>
          <p>We are pleased to inform you that <strong>${plotLabel}</strong> ${siteLabel} is now available again.</p>
          <p>As you are at the top of the queue, our administration team has been notified to proceed with your allotment.</p>
          <p style="color: #64748b; font-size: 13px; margin-top: 24px;">MMR Constructions ERP Desk.</p>
        </div>
      `;
      break;

    case 'plot_sold':
      title = 'Plot Registry Completed & Unit Sold';
      inAppMessage = `Congratulations! Registry completed for ${plotLabel} ${siteLabel}. Deed No: ${registryNo || 'N/A'}. Marked as Sold.`;
      emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #059669; margin-top: 0;">🏆 Plot Registry &amp; Sale Complete</h2>
          <p>Dear <strong>${customerName}</strong>,</p>
          <p>Congratulations! All statutory formalities and payments for <strong>${plotLabel}</strong> ${siteLabel} have been completed successfully.</p>
          <div style="background: #ecfdf5; border-left: 4px solid #059669; padding: 12px 16px; margin: 16px 0;">
            <p style="margin: 4px 0;"><strong>Registry / Deed No:</strong> ${registryNo || 'Recorded'}</p>
            <p style="margin: 4px 0;"><strong>Status:</strong> Officially Sold &amp; Registered</p>
          </div>
          <p>Thank you for choosing MMR Constructions as your trusted real estate partner.</p>
          <p style="color: #64748b; font-size: 13px; margin-top: 24px;">MMR Constructions — Building Dreams with Trust.</p>
        </div>
      `;
      break;

    case 'booking_cancelled':
      title = 'Plot Booking Cancelled';
      inAppMessage = `Your booking for ${plotLabel} ${siteLabel} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`;
      emailHtml = `
        <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #dc2626; margin-top: 0;">Booking Cancelled</h2>
          <p>Dear <strong>${customerName}</strong>,</p>
          <p>Your booking for <strong>${plotLabel}</strong> ${siteLabel} has been cancelled.</p>
          ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
          <p>If you have any questions regarding your refund or account, please reach out to our office.</p>
          <p style="color: #64748b; font-size: 13px; margin-top: 24px;">MMR Constructions ERP Desk.</p>
        </div>
      `;
      break;

    default:
      title = 'Booking Update';
      inAppMessage = `Update regarding your booking for ${plotLabel} ${siteLabel}.`;
      emailHtml = `<p>Dear ${customerName}, there is an update regarding your booking for ${plotLabel}.</p>`;
  }

  // 1. In-App Notification (Always attempt)
  if (userId) {
    try {
      await sql`
        INSERT INTO notification_log (
          user_id,
          title,
          message,
          channel,
          is_read,
          sent_at
        ) VALUES (
          ${userId},
          ${title},
          ${inAppMessage},
          'in_app',
          FALSE,
          NOW()
        )
      `;
    } catch (notifErr) {
      console.warn(`[NotificationService] Failed to insert notification_log for user ${userId}:`, notifErr.message);
    }
  }

  // 2. Email Notification (Nodemailer via emailService.js, safe non-blocking)
  if (userEmail) {
    try {
      sendEmail(userEmail, `${title} - MMR Constructions`, emailHtml).catch((emailErr) => {
        console.warn(`[NotificationService] SMTP sending failed for ${userEmail}:`, emailErr.message);
      });
    } catch (e) {
      console.warn(`[NotificationService] SMTP dispatch error:`, e.message);
    }
  }

  return { success: true };
}

export default {
  dispatchBookingNotification
};
