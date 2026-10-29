/**
 * Standalone Email Templates for Phase 3:
 * 1. Digital Payment & EMI Installment Receipt
 * 2. Payment Rejection / Verification Failed
 * 3. Upcoming EMI Due Reminder
 * 4. Plot Registry & Ownership Deed Complete (Mark Sold)
 * 5. Plot Booking Cancelled & Refund Due
 */

function escapeHtml(str = '') {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCurrency(amount = 0) {
  const num = Number(amount) || 0;
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(date) {
  if (!date) return '—';
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return String(date);
    return d.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  } catch (_) {
    return String(date);
  }
}

function renderEmailShell({ title, badgeText, badgeColor = '#22c55e', contentHtml, referenceId = null }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #1e293b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f1f5f9; padding: 24px 12px;">
    <tr>
      <td align="center">
        <!-- Main Card Container -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 620px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08); border: 1px solid #e2e8f0;">
          
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #0e3b1c 0%, #155724 60%, #1d7232 100%); padding: 28px 24px; text-align: center; border-bottom: 3px solid #d4af37;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center">
                    <div style="font-size: 24px; font-weight: 800; color: #ffffff; letter-spacing: 0.5px; text-transform: uppercase;">
                      MMR CONSTRUCTIONS
                    </div>
                    <div style="font-size: 11px; font-weight: 600; color: #fde047; letter-spacing: 1.5px; text-transform: uppercase; margin-top: 4px;">
                      &amp; Developers Private Limited
                    </div>
                    <div style="font-size: 11px; color: #dcfce7; margin-top: 6px;">
                      Building Trust &bull; Delivering Excellence
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Sub-header Title & Badge -->
          <tr>
            <td style="background-color: #f8fafc; padding: 18px 24px; border-bottom: 1px solid #e2e8f0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="left" style="vertical-align: middle;">
                    <h1 style="margin: 0; font-size: 18px; font-weight: 700; color: #0f172a;">
                      ${escapeHtml(title)}
                    </h1>
                    ${referenceId ? `<div style="font-size: 12px; color: #64748b; margin-top: 3px;">Ref: <strong style="color: #0f172a;">${escapeHtml(referenceId)}</strong></div>` : ''}
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <span style="display: inline-block; background-color: ${badgeColor}; color: #ffffff; font-size: 11px; font-weight: 700; padding: 5px 12px; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.5px;">
                      ${escapeHtml(badgeText)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content Body -->
          <tr>
            <td style="padding: 24px;">
              ${contentHtml}
            </td>
          </tr>

          <!-- Official Footer -->
          <tr>
            <td style="background-color: #0f172a; padding: 24px; text-align: center; color: #94a3b8; font-size: 12px; line-height: 1.6; border-top: 1px solid #334155;">
              <div style="color: #f8fafc; font-weight: 700; font-size: 13px; margin-bottom: 4px;">
                MMR Constructions &amp; Developers Pvt. Ltd.
              </div>
              <div>Registered Office: Uttar Pradesh, India</div>
              <div style="margin-top: 8px;">
                Email: <a href="mailto:support@mmrconstructions.in" style="color: #60a5fa; text-decoration: none;">support@mmrconstructions.in</a> &bull; Website: <a href="https://mmrconstructions.in" style="color: #60a5fa; text-decoration: none;">mmrconstructions.in</a>
              </div>
              <div style="margin-top: 14px; font-size: 11px; color: #64748b; border-top: 1px solid #1e293b; padding-top: 12px;">
                This is an official transactional notification generated by the MMR Constructions Accounts &amp; ERP System.
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// 1. DIGITAL PAYMENT & EMI RECEIPT TEMPLATE
// ─────────────────────────────────────────────────────────────

export function generateEmiReceiptEmailHtml(data = {}) {
  const {
    customerName = 'Valued Customer',
    receiptNo = '—',
    paymentSerial = '—',
    plotNumber = '—',
    siteName = 'MMR Project',
    installmentNo = null,
    amountPaid = 0,
    paymentMode = 'Online',
    paymentDate = new Date(),
    remainingBalance = null,
    nextDueDate = null,
    verifiedBy = 'Finance Operations',
    receiptUrl = null,
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(customerName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      We have successfully received and verified your property payment. Please find your official digital payment receipt below.
    </p>

    <!-- Payment Highlight Card -->
    <div style="background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%); border: 2px dashed #059669; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #047857; text-transform: uppercase; letter-spacing: 1px;">
        Payment Received &amp; Verified
      </div>
      <div style="font-size: 32px; font-weight: 800; color: #065f46; margin: 6px 0;">
        ${formatCurrency(amountPaid)}
      </div>
      <div style="font-size: 13px; color: #047857;">
        Receipt Number: <strong>${escapeHtml(receiptNo)}</strong>
      </div>
    </div>

    <!-- Payment & Property Breakdown Table -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #334155; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Receipt Summary
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="42%" style="color: #64748b;">Receipt Number:</td>
          <td width="58%"><strong>${escapeHtml(receiptNo)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Transaction Reference:</td>
          <td><strong>${escapeHtml(paymentSerial)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Property / Unit:</td>
          <td><strong>${escapeHtml(plotNumber)}</strong> (${escapeHtml(siteName)})</td>
        </tr>
        ${installmentNo ? `
        <tr>
          <td style="color: #64748b;">Installment Number:</td>
          <td><span style="display: inline-block; background-color: #e0f2fe; color: #0369a1; font-weight: 700; padding: 2px 8px; border-radius: 4px;">EMI #${escapeHtml(installmentNo)}</span></td>
        </tr>
        ` : ''}
        <tr>
          <td style="color: #64748b;">Mode of Payment:</td>
          <td>${escapeHtml(paymentMode)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Payment Date:</td>
          <td>${formatDate(paymentDate)}</td>
        </tr>
        ${remainingBalance !== null ? `
        <tr>
          <td style="color: #64748b;">Remaining Balance:</td>
          <td><strong>${formatCurrency(remainingBalance)}</strong></td>
        </tr>
        ` : ''}
        ${nextDueDate ? `
        <tr>
          <td style="color: #64748b;">Next Due Date:</td>
          <td><strong style="color: #b45309;">${formatDate(nextDueDate)}</strong></td>
        </tr>
        ` : ''}
        <tr>
          <td style="color: #64748b;">Authorized Desk:</td>
          <td>${escapeHtml(verifiedBy)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      This receipt has been recorded into your immutable customer ledger. You can download and print official stamp-signed PDF receipts at any time from your customer dashboard.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="${receiptUrl || 'https://mmrconstructions.in/customer/dashboard'}" style="display: inline-block; background-color: #059669; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        View / Download Official Receipt &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Payment Receipt Confirmed',
    badgeText: 'Payment Verified',
    badgeColor: '#059669',
    referenceId: receiptNo,
    contentHtml,
  });
}

// ─────────────────────────────────────────────────────────────
// 2. PAYMENT REJECTION / VERIFICATION FAILED TEMPLATE
// ─────────────────────────────────────────────────────────────

export function generatePaymentRejectionEmailHtml(data = {}) {
  const {
    customerName = 'Valued Customer',
    paymentSerial = '—',
    plotNumber = '—',
    siteName = 'MMR Project',
    amount = 0,
    rejectionReason = 'Proof of payment could not be reconciled.',
    paymentDate = new Date(),
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(customerName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      We are writing to update you regarding your recent offline payment / installment submission for <strong>${escapeHtml(plotNumber)} (${escapeHtml(siteName)})</strong>.
    </p>

    <!-- Rejection Alert Card -->
    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">
        Verification Status: Declined
      </div>
      <div style="font-size: 14px; color: #b91c1c; font-weight: 600; margin-bottom: 4px;">
        ${escapeHtml(rejectionReason)}
      </div>
    </div>

    <!-- Payment Details -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin: 20px 0; font-size: 13px; color: #334155;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="4" border="0">
        <tr>
          <td width="40%" style="color: #64748b;">Transaction Reference:</td>
          <td width="60%"><strong>${escapeHtml(paymentSerial)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Submitted Amount:</td>
          <td>${formatCurrency(amount)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Submission Date:</td>
          <td>${formatDate(paymentDate)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      Please log in to your Customer Portal to upload a clear bank transaction receipt / cheque slip, or complete your payment seamlessly via Online UPI / Net Banking.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/customer/dashboard" style="display: inline-block; background-color: #dc2626; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Review &amp; Re-submit Payment &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Payment Verification Update',
    badgeText: 'Action Required',
    badgeColor: '#dc2626',
    referenceId: paymentSerial,
    contentHtml,
  });
}

// ─────────────────────────────────────────────────────────────
// 3. UPCOMING EMI DUE REMINDER TEMPLATE
// ─────────────────────────────────────────────────────────────

export function generateEmiDueReminderEmailHtml(data = {}) {
  const {
    customerName = 'Valued Customer',
    plotNumber = '—',
    siteName = 'MMR Project',
    installmentNo = 1,
    emiAmount = 0,
    dueDate = new Date(),
    payOnlineUrl = 'https://mmrconstructions.in/customer/dashboard',
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(customerName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      This is a gentle reminder that your upcoming monthly installment for <strong>Plot ${escapeHtml(plotNumber)} (${escapeHtml(siteName)})</strong> is scheduled for payment.
    </p>

    <!-- Due Notice Box -->
    <div style="background-color: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #92400e; text-transform: uppercase; letter-spacing: 1px;">
        Installment Amount Due
      </div>
      <div style="font-size: 32px; font-weight: 800; color: #b45309; margin: 6px 0;">
        ${formatCurrency(emiAmount)}
      </div>
      <div style="font-size: 13px; color: #92400e;">
        Due Date: <strong>${formatDate(dueDate)}</strong>
      </div>
    </div>

    <!-- Property Details Table -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin: 20px 0; font-size: 13px; color: #334155;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="4" border="0">
        <tr>
          <td width="40%" style="color: #64748b;">Installment Number:</td>
          <td width="60%"><strong>EMI #${escapeHtml(installmentNo)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Plot Number:</td>
          <td><strong>${escapeHtml(plotNumber)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Project / Site:</td>
          <td>${escapeHtml(siteName)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      Timely installment payments protect your allocation schedule and ensure seamless property registry processing.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="${payOnlineUrl}" style="display: inline-block; background-color: #b45309; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Pay Online Now &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Upcoming EMI Due Reminder',
    badgeText: 'Payment Due',
    badgeColor: '#f59e0b',
    referenceId: `Plot ${plotNumber}`,
    contentHtml,
  });
}

// ─────────────────────────────────────────────────────────────
// 4. PLOT REGISTRY & DEED COMPLETE (MARK SOLD)
// ─────────────────────────────────────────────────────────────

export function generatePlotSoldRegistryEmailHtml(data = {}) {
  const {
    customerName = 'Valued Customer',
    plotNumber = '—',
    siteName = 'MMR Project',
    registryNo = '—',
    registryDate = new Date(),
    possessionDate = null,
    finalSoldPrice = 0,
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(customerName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Heartiest congratulations on completing all legal formalities and statutory registry for your property! We proudly celebrate your milestone ownership with MMR Constructions.
    </p>

    <!-- Ownership Milestone Box -->
    <div style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border: 2px solid #16a34a; border-radius: 8px; padding: 22px; text-align: center; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #166534; text-transform: uppercase; letter-spacing: 1px;">
        Official Ownership Milestone
      </div>
      <div style="font-size: 26px; font-weight: 800; color: #14532d; margin: 8px 0;">
        Plot ${escapeHtml(plotNumber)} &bull; ${escapeHtml(siteName)}
      </div>
      <div style="font-size: 13px; color: #166534;">
        Deed Registry Status: <strong>Officially Registered &amp; Sold</strong>
      </div>
    </div>

    <!-- Registry Record Details -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #334155; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Registry &amp; Deed Particulars
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="42%" style="color: #64748b;">Deed / Registry No:</td>
          <td width="58%"><strong>${escapeHtml(registryNo)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Registration Date:</td>
          <td><strong>${formatDate(registryDate)}</strong></td>
        </tr>
        ${possessionDate ? `
        <tr>
          <td style="color: #64748b;">Possession Handover:</td>
          <td><strong>${formatDate(possessionDate)}</strong></td>
        </tr>
        ` : ''}
        <tr>
          <td style="color: #64748b;">Total Property Value:</td>
          <td>${formatCurrency(finalSoldPrice)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Payment Status:</td>
          <td><span style="display: inline-block; background-color: #dcfce7; color: #166534; font-weight: 700; padding: 2px 8px; border-radius: 4px;">100% Fully Settled</span></td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      Thank you for placing your valuable trust in MMR Constructions &amp; Developers. We wish you and your family prosperous beginnings on your new property.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/customer/dashboard" style="display: inline-block; background-color: #155724; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        View Final Plot Ownership Records &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Plot Deed Registry Complete',
    badgeText: 'Officially Sold',
    badgeColor: '#16a34a',
    referenceId: registryNo,
    contentHtml,
  });
}

// ─────────────────────────────────────────────────────────────
// 5. PLOT BOOKING CANCELLED & REFUND DUE
// ─────────────────────────────────────────────────────────────

export function generateBookingCancellationEmailHtml(data = {}) {
  const {
    customerName = 'Valued Customer',
    bookingSerial = '—',
    plotNumber = '—',
    siteName = 'MMR Project',
    reason = 'Cancelled by administration',
    refundDue = true,
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(customerName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      This email is to notify you that your booking for <strong>Plot ${escapeHtml(plotNumber)} (${escapeHtml(siteName)})</strong> has been cancelled.
    </p>

    <!-- Cancellation Notice -->
    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">
        Cancellation Reason
      </div>
      <div style="font-size: 14px; color: #b91c1c; font-weight: 600;">
        ${escapeHtml(reason)}
      </div>
    </div>

    <!-- Booking Summary -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin: 20px 0; font-size: 13px; color: #334155;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="4" border="0">
        <tr>
          <td width="40%" style="color: #64748b;">Booking Reference:</td>
          <td width="60%"><strong>${escapeHtml(bookingSerial)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Refund Status:</td>
          <td>${refundDue ? '<strong style="color: #0369a1;">Refund Due &amp; Marked for Finance Processing</strong>' : 'No Refund Applicable'}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      Our accounts department will process eligible refunds per company allotment terms. You may also transfer your credit to another available plot of your choice.
    </p>

    <div style="text-align: center; margin: 20px 0 10px 0;">
      <a href="https://mmrconstructions.in/customer/dashboard" style="display: inline-block; background-color: #334155; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Visit Customer Desk &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Plot Booking Cancelled',
    badgeText: 'Booking Cancelled',
    badgeColor: '#dc2626',
    referenceId: bookingSerial,
    contentHtml,
  });
}

