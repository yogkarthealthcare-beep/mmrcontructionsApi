/**
 * Standalone Email Templates for Phase 1:
 * 1. Plot Booking (Customer, Team Member, Associate, Self-Purchase)
 * 2. Commission Settlement Release (Team Member & Associate)
 * 3. Withdrawal Request & Payout Status (User Acknowledgement, Admin Alert, Release, Rejection)
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
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (_) {
    return String(date);
  }
}

function maskAccountNumber(acc = '') {
  const s = String(acc || '').trim();
  if (s.length <= 4) return s;
  return '•••• ' + s.slice(-4);
}

// ─────────────────────────────────────────────────────────────
// Shared Header & Footer Shell
// ─────────────────────────────────────────────────────────────

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
                This is an automated transactional message generated by the MMR Constructions Core ERP system. Please do not reply directly to this email.
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
// 1. PLOT BOOKING TEMPLATES
// ─────────────────────────────────────────────────────────────

/**
 * 1A. Customer Booking Confirmation Email
 */
export function generatePlotBookingCustomerEmailHtml(data = {}) {
  const {
    bookingSerial = '—',
    customerName = 'Valued Customer',
    plotNumber = '—',
    plotArea = '—',
    siteName = 'MMR Project',
    basePrice = 0,
    advanceAmount = 0,
    remainingBalance = 0,
    paymentMethod = 'Online',
    paymentStatus = 'Received',
    bookingDate = new Date(),
    teamMemberName = null,
    teamMemberContact = null,
    associateName = null,
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(customerName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Congratulations! We are delighted to confirm that your plot booking application has been successfully recorded with MMR Constructions.
    </p>

    <!-- Key Booking Details Card -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #155724; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Property Allotment Details
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Booking Serial No:</td>
          <td width="60%"><strong>${escapeHtml(bookingSerial)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Project / Site:</td>
          <td><strong>${escapeHtml(siteName)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Allotted Plot No:</td>
          <td><span style="display: inline-block; background-color: #dcfce7; color: #166534; font-weight: 700; padding: 2px 8px; border-radius: 4px;">${escapeHtml(plotNumber)}</span></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Plot Size / Area:</td>
          <td>${escapeHtml(plotArea)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Total Plot Value:</td>
          <td>${formatCurrency(basePrice)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Advance Paid:</td>
          <td><strong style="color: #166534;">${formatCurrency(advanceAmount)}</strong> (${escapeHtml(paymentStatus)})</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Remaining Balance:</td>
          <td><strong>${formatCurrency(remainingBalance)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Payment Mode:</td>
          <td>${escapeHtml(paymentMethod)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Booking Date:</td>
          <td>${formatDate(bookingDate)}</td>
        </tr>
      </table>
    </div>

    ${teamMemberName || associateName ? `
    <!-- Assigned Relationship Executives -->
    <div style="background-color: #ecfdf5; border-left: 4px solid #10b981; padding: 14px 16px; border-radius: 4px; margin-bottom: 20px; font-size: 13px; color: #065f46;">
      <div style="font-weight: 700; margin-bottom: 6px;">Your Dedicated Relationship Team:</div>
      ${teamMemberName ? `<div>&bull; Team Member: <strong>${escapeHtml(teamMemberName)}</strong> ${teamMemberContact ? `(${escapeHtml(teamMemberContact)})` : ''}</div>` : ''}
      ${associateName ? `<div>&bull; Senior Associate Partner: <strong>${escapeHtml(associateName)}</strong></div>` : ''}
    </div>
    ` : ''}

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      You can track your plot allotment status, installment EMI calendar, and official receipts anytime by logging into the <strong>Customer Portal</strong>.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/customer/dashboard" style="display: inline-block; background-color: #155724; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
        View My Plot Dashboard &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Plot Booking Confirmation',
    badgeText: 'Booking Confirmed',
    badgeColor: '#16a34a',
    referenceId: bookingSerial,
    contentHtml,
  });
}

/**
 * 1B. Team Member Notification: Customer Sale Credited
 */
export function generatePlotBookingTeamMemberEmailHtml(data = {}) {
  const {
    teamMemberName = 'Team Member',
    customerName = 'Customer',
    bookingSerial = '—',
    plotNumber = '—',
    siteName = 'MMR Project',
    advanceAmount = 0,
    basePrice = 0,
    bookingDate = new Date(),
    prospectiveCommission = null,
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(teamMemberName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Great news! A new customer plot order has been booked under your direct sales network.
    </p>

    <!-- Sale & Attribution Summary -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #0284c7; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Sales Attribution Details
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Buyer / Customer:</td>
          <td width="60%"><strong>${escapeHtml(customerName)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Booking Reference:</td>
          <td><strong>${escapeHtml(bookingSerial)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Project / Site:</td>
          <td>${escapeHtml(siteName)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Plot Number:</td>
          <td><strong>${escapeHtml(plotNumber)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Total Plot Value:</td>
          <td>${formatCurrency(basePrice)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Advance Received:</td>
          <td><strong style="color: #0284c7;">${formatCurrency(advanceAmount)}</strong></td>
        </tr>
        ${prospectiveCommission !== null ? `
        <tr>
          <td style="color: #64748b;">Expected Commission:</td>
          <td><strong style="color: #16a34a;">${formatCurrency(prospectiveCommission)}</strong> (Pending Settlement)</td>
        </tr>
        ` : ''}
        <tr>
          <td style="color: #64748b;">Booking Timestamp:</td>
          <td>${formatDate(bookingDate)}</td>
        </tr>
      </table>
    </div>

    <div style="background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px 16px; border-radius: 4px; font-size: 13px; color: #1e40af; margin-bottom: 20px;">
      Commission will be released into your wallet once the settlement is authorized and processed by the administration.
    </div>

    <div style="text-align: center; margin: 20px 0 10px 0;">
      <a href="https://mmrconstructions.in/team-member/commissions" style="display: inline-block; background-color: #0284c7; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Track Team Member Commissions &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'New Customer Plot Sale Credited',
    badgeText: 'Sales Credited',
    badgeColor: '#0284c7',
    referenceId: bookingSerial,
    contentHtml,
  });
}

/**
 * 1C. Associate Partner Notification: Network Team Booking
 */
export function generatePlotBookingAssociateEmailHtml(data = {}) {
  const {
    associateName = 'Associate Partner',
    teamMemberName = 'Team Member',
    customerName = 'Customer',
    bookingSerial = '—',
    plotNumber = '—',
    siteName = 'MMR Project',
    advanceAmount = 0,
    basePrice = 0,
    bookingDate = new Date(),
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(associateName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      A new plot booking has been recorded within your associate hierarchy network.
    </p>

    <!-- Hierarchy Booking Card -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #7c3aed; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Network Performance Record
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Enrolling Team Member:</td>
          <td width="60%"><strong>${escapeHtml(teamMemberName)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Customer / Buyer:</td>
          <td>${escapeHtml(customerName)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Booking Reference:</td>
          <td><strong>${escapeHtml(bookingSerial)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Project &amp; Plot:</td>
          <td><strong>${escapeHtml(plotNumber)}</strong> (${escapeHtml(siteName)})</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Plot Total Value:</td>
          <td>${formatCurrency(basePrice)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Advance Received:</td>
          <td><strong style="color: #7c3aed;">${formatCurrency(advanceAmount)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Timestamp:</td>
          <td>${formatDate(bookingDate)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      Your override pool commission will be automatically processed into your Associate Wallet upon payment settlement authorization.
    </p>

    <div style="text-align: center; margin: 20px 0 10px 0;">
      <a href="https://mmrconstructions.in/associate/portal" style="display: inline-block; background-color: #7c3aed; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Open Associate Network Portal &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'New Booking in Your Associate Network',
    badgeText: 'Hierarchy Sale',
    badgeColor: '#7c3aed',
    referenceId: bookingSerial,
    contentHtml,
  });
}

/**
 * 1D. Self-Purchase Booking Confirmation (Team Member or Associate buying for themselves)
 */
export function generatePlotBookingSelfPurchaseEmailHtml(data = {}) {
  const {
    buyerName = 'Member',
    role = 'Team Member',
    bookingSerial = '—',
    plotNumber = '—',
    plotArea = '—',
    siteName = 'MMR Project',
    basePrice = 0,
    advanceAmount = 0,
    remainingBalance = 0,
    paymentMethod = 'Online',
    bookingDate = new Date(),
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(buyerName)}</strong> (${escapeHtml(role)}),
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Your personal property booking application (Self-Purchase) has been successfully verified and confirmed.
    </p>

    <!-- Self Purchase Card -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #0f766e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Self-Purchase Allotment Summary
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Booking Reference:</td>
          <td width="60%"><strong>${escapeHtml(bookingSerial)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Purchased As:</td>
          <td><strong>Self-Booking (${escapeHtml(role)})</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Project &amp; Unit:</td>
          <td><strong>${escapeHtml(plotNumber)}</strong> (${escapeHtml(siteName)})</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Plot Area:</td>
          <td>${escapeHtml(plotArea)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Total Property Value:</td>
          <td>${formatCurrency(basePrice)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Advance Paid:</td>
          <td><strong style="color: #0f766e;">${formatCurrency(advanceAmount)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Remaining Balance:</td>
          <td><strong>${formatCurrency(remainingBalance)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Payment Mode:</td>
          <td>${escapeHtml(paymentMethod)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Booking Date:</td>
          <td>${formatDate(bookingDate)}</td>
        </tr>
      </table>
    </div>

    <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; padding: 12px 16px; border-radius: 6px; font-size: 13px; color: #166534; margin-bottom: 20px;">
      <strong>Notice:</strong> Per MMR company policy, direct self-purchase property acquisitions carry 0% referral commission attribution and remain exclusively confidential to your individual account.
    </div>

    <div style="text-align: center; margin: 20px 0 10px 0;">
      <a href="https://mmrconstructions.in" style="display: inline-block; background-color: #0f766e; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        View Booking In Portal &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Self-Purchase Booking Confirmed',
    badgeText: 'Self-Purchase',
    badgeColor: '#0f766e',
    referenceId: bookingSerial,
    contentHtml,
  });
}

// ─────────────────────────────────────────────────────────────
// 2. COMMISSION SETTLEMENT RELEASE TEMPLATES
// ─────────────────────────────────────────────────────────────

/**
 * 2A. Commission Settlement Credited Email (Associate or Team Member)
 */
export function generateCommissionSettlementEmailHtml(data = {}) {
  const {
    recipientName = 'Member',
    userRole = 'Team Member',
    settlementReference = '—',
    bookingSerial = '—',
    plotNumber = '—',
    siteName = 'MMR Project',
    customerName = 'Customer',
    commissionAmount = 0,
    updatedAvailableBalance = 0,
    adminName = 'Finance Desk',
    releasedAt = new Date(),
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(recipientName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      We are pleased to inform you that commission payment has been officially authorized and released into your <strong>${escapeHtml(userRole)} Wallet</strong>.
    </p>

    <!-- Credit Amount Highlight Box -->
    <div style="background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%); border: 2px dashed #059669; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #047857; text-transform: uppercase; letter-spacing: 1px;">
        Commission Credited To Wallet
      </div>
      <div style="font-size: 32px; font-weight: 800; color: #065f46; margin: 8px 0;">
        +${formatCurrency(commissionAmount)}
      </div>
      <div style="font-size: 13px; color: #047857;">
        Updated Available Balance: <strong>${formatCurrency(updatedAvailableBalance)}</strong>
      </div>
    </div>

    <!-- Settlement Details Table -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #334155; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Settlement Breakdown
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="42%" style="color: #64748b;">Settlement Ref:</td>
          <td width="58%"><strong>${escapeHtml(settlementReference)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Associated Order:</td>
          <td><strong>${escapeHtml(bookingSerial)}</strong> (${escapeHtml(plotNumber)} - ${escapeHtml(siteName)})</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Customer / Buyer:</td>
          <td>${escapeHtml(customerName)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Credited User Role:</td>
          <td>${escapeHtml(userRole)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Authorized By:</td>
          <td>${escapeHtml(adminName)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Release Timestamp:</td>
          <td>${formatDate(releasedAt)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      This amount is immediately available in your wallet for withdrawals or internal transfers.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/wallet" style="display: inline-block; background-color: #059669; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        View Wallet &amp; Withdraw &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Commission Payment Released',
    badgeText: 'Wallet Credited',
    badgeColor: '#059669',
    referenceId: settlementReference,
    contentHtml,
  });
}

// ─────────────────────────────────────────────────────────────
// 3. WITHDRAWAL TEMPLATES (User & Admin)
// ─────────────────────────────────────────────────────────────

/**
 * 3A. Withdrawal Request Received (User Acknowledgment)
 */
export function generateWithdrawalRequestUserEmailHtml(data = {}) {
  const {
    userName = 'Member',
    userRole = 'Associate',
    withdrawalId = '—',
    amount = 0,
    bankName = '—',
    accountNumber = '—',
    ifscCode = '—',
    requestedAt = new Date(),
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(userName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      We have received your withdrawal request from your <strong>${escapeHtml(userRole)} Wallet</strong>. Our finance operations desk is reviewing the payout instruction.
    </p>

    <!-- Withdrawal Request Details -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #d97706; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Request Details
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Withdrawal ID:</td>
          <td width="60%"><strong>#${escapeHtml(withdrawalId)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Requested Amount:</td>
          <td><strong style="color: #b45309; font-size: 16px;">${formatCurrency(amount)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Bank Name:</td>
          <td>${escapeHtml(bankName)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Account Number:</td>
          <td><code>${maskAccountNumber(accountNumber)}</code></td>
        </tr>
        <tr>
          <td style="color: #64748b;">IFSC Code:</td>
          <td><code>${escapeHtml(ifscCode)}</code></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Status:</td>
          <td><span style="display: inline-block; background-color: #fef3c7; color: #92400e; font-weight: 700; padding: 2px 8px; border-radius: 4px;">Pending Admin Verification</span></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Requested At:</td>
          <td>${formatDate(requestedAt)}</td>
        </tr>
      </table>
    </div>

    <div style="background-color: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 4px; font-size: 13px; color: #92400e; margin-bottom: 20px;">
      The requested amount has been temporarily moved to your pending balance to avoid duplicate debit. You will receive an immediate email once the bank transfer is executed.
    </div>

    <p style="font-size: 12px; color: #64748b;">Expected processing timeline: 1–2 business days.</p>
  `;

  return renderEmailShell({
    title: 'Withdrawal Request Received',
    badgeText: 'Processing',
    badgeColor: '#f59e0b',
    referenceId: `#${withdrawalId}`,
    contentHtml,
  });
}

/**
 * 3B. Withdrawal Request Alert (To Admin)
 */
export function generateWithdrawalRequestAdminEmailHtml(data = {}) {
  const {
    userName = 'User',
    userEmail = '—',
    userRole = 'Associate',
    userId = '—',
    withdrawalId = '—',
    amount = 0,
    bankName = '—',
    accountNumber = '—',
    ifscCode = '—',
    upiId = null,
    requestedAt = new Date(),
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      <strong>Action Required:</strong> A new wallet withdrawal request has been submitted and is awaiting finance authorization.
    </p>

    <!-- Requester Profile & Bank Details Card -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #dc2626; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Payout Verification Requisition
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Withdrawal ID:</td>
          <td width="60%"><strong>#${escapeHtml(withdrawalId)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Requester:</td>
          <td><strong>${escapeHtml(userName)}</strong> (${escapeHtml(userRole)} ID #${escapeHtml(userId)})</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Requester Email:</td>
          <td>${escapeHtml(userEmail)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Payout Amount:</td>
          <td><strong style="color: #dc2626; font-size: 16px;">${formatCurrency(amount)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Target Bank:</td>
          <td>${escapeHtml(bankName)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Bank Account:</td>
          <td><code>${escapeHtml(accountNumber)}</code></td>
        </tr>
        <tr>
          <td style="color: #64748b;">IFSC Code:</td>
          <td><code>${escapeHtml(ifscCode)}</code></td>
        </tr>
        ${upiId ? `
        <tr>
          <td style="color: #64748b;">UPI ID:</td>
          <td><code>${escapeHtml(upiId)}</code></td>
        </tr>
        ` : ''}
        <tr>
          <td style="color: #64748b;">Requested Timestamp:</td>
          <td>${formatDate(requestedAt)}</td>
        </tr>
      </table>
    </div>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/admin/wallet-payouts" style="display: inline-block; background-color: #0e3b1c; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Review &amp; Authorize Payout in Admin Panel &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Admin Alert: New Withdrawal Request',
    badgeText: 'Admin Attention',
    badgeColor: '#dc2626',
    referenceId: `#${withdrawalId}`,
    contentHtml,
  });
}

/**
 * 3C. Withdrawal Released (Payout Transferred to User)
 */
export function generateWithdrawalReleasedEmailHtml(data = {}) {
  const {
    userName = 'Member',
    userRole = 'Associate',
    withdrawalId = '—',
    amount = 0,
    payoutReference = 'REF-MAN-PROCESSED',
    bankName = '—',
    accountNumber = '—',
    releasedAt = new Date(),
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(userName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Great news! Your withdrawal request has been approved and the funds have been successfully transferred to your registered bank account.
    </p>

    <!-- Transferred Details -->
    <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 18px; margin: 20px 0; text-align: center;">
      <div style="font-size: 12px; font-weight: 700; color: #065f46; text-transform: uppercase; letter-spacing: 0.5px;">
        Amount Disbursed
      </div>
      <div style="font-size: 28px; font-weight: 800; color: #047857; margin: 6px 0;">
        ${formatCurrency(amount)}
      </div>
      <div style="font-size: 12px; color: #065f46;">
        Payment Status: <strong>Transferred / Disbursed</strong>
      </div>
    </div>

    <!-- Payout Information -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="42%" style="color: #64748b;">Withdrawal ID:</td>
          <td width="58%"><strong>#${escapeHtml(withdrawalId)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Bank UTR / Reference:</td>
          <td><strong style="color: #047857;">${escapeHtml(payoutReference)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Destination Bank:</td>
          <td>${escapeHtml(bankName)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Account Credited:</td>
          <td><code>${maskAccountNumber(accountNumber)}</code></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Disbursement Date:</td>
          <td>${formatDate(releasedAt)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      Depending on your bank’s clearing network (IMPS/NEFT/RTGS), the amount should reflect in your statement immediately or within a few hours.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/wallet" style="display: inline-block; background-color: #047857; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        View Wallet Transaction History &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Withdrawal Payout Released',
    badgeText: 'Paid / Transferred',
    badgeColor: '#059669',
    referenceId: payoutReference,
    contentHtml,
  });
}

/**
 * 3D. Withdrawal Rejected (Funds Refunded to Wallet)
 */
export function generateWithdrawalRejectedEmailHtml(data = {}) {
  const {
    userName = 'Member',
    userRole = 'Associate',
    withdrawalId = '—',
    amount = 0,
    rejectionReason = 'Administrative review criteria not met.',
    rejectedAt = new Date(),
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(userName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      We are writing to notify you that your withdrawal request has been declined following administrative review.
    </p>

    <!-- Refund Notification Box -->
    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #b91c1c; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">
        Rejection Reason
      </div>
      <div style="font-size: 14px; color: #991b1b; font-weight: 600;">
        ${escapeHtml(rejectionReason)}
      </div>
    </div>

    <!-- Request Details -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Withdrawal ID:</td>
          <td width="60%"><strong>#${escapeHtml(withdrawalId)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Declined Amount:</td>
          <td><strong>${formatCurrency(amount)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Refund Status:</td>
          <td><strong style="color: #15803d;">100% Refunded back to Available Balance</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Reviewed At:</td>
          <td>${formatDate(rejectedAt)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      The full amount of <strong>${formatCurrency(amount)}</strong> has been instantly credited back to your <strong>${escapeHtml(userRole)} Available Balance</strong>. You may update your bank/KYC details and re-apply.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/wallet" style="display: inline-block; background-color: #334155; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Check Wallet Balance &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Withdrawal Request Update',
    badgeText: 'Rejected & Refunded',
    badgeColor: '#dc2626',
    referenceId: `#${withdrawalId}`,
    contentHtml,
  });
}

