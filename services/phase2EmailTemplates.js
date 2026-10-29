/**
 * Standalone Email Templates for Phase 2:
 * 1. Customer Enrollment Approval & Rejection
 * 2. Associate Partner Approval & Rejection
 * 3. Team Member Enrollment Approval & Rejection
 * 4. Investor KYC / Account Approval & Rejection
 * 5. Investor Deposit Request (User Ack + Admin Alert) & Status (Approved / Rejected)
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
                This is an automated transactional message generated by the MMR Constructions Core ERP system.
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
// 1. CUSTOMER ENROLLMENT STATUS TEMPLATES
// ─────────────────────────────────────────────────────────────

export function generateCustomerStatusEmailHtml(data = {}) {
  const {
    customerName = 'Valued Customer',
    applicationNo = '—',
    status = 'approved',
    reason = null,
    memberId = null,
    approvedBy = 'Administration',
    updatedAt = new Date(),
  } = data;

  const isApproved = ['approved', 'completed'].includes(String(status).toLowerCase());

  const contentHtml = isApproved ? `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(customerName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Hearty congratulations! We are delighted to inform you that your Customer Enrollment application has been <strong>approved</strong> by the MMR Constructions verification board.
    </p>

    <!-- Approved Details Card -->
    <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #166534; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Enrollment Verification Summary
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Application Number:</td>
          <td width="60%"><strong>${escapeHtml(applicationNo)}</strong></td>
        </tr>
        ${memberId ? `
        <tr>
          <td style="color: #64748b;">Customer Member ID:</td>
          <td><span style="display: inline-block; background-color: #dcfce7; color: #166534; font-weight: 700; padding: 2px 8px; border-radius: 4px;">${escapeHtml(memberId)}</span></td>
        </tr>
        ` : ''}
        <tr>
          <td style="color: #64748b;">Enrollment Status:</td>
          <td><strong style="color: #16a34a;">Approved &amp; Active</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Authorized By:</td>
          <td>${escapeHtml(approvedBy)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Approval Date:</td>
          <td>${formatDate(updatedAt)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      Your customer portal is now active. You may log in to select and book your dream plots, download allotment certificates, and track EMI installment schedules.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/login" style="display: inline-block; background-color: #155724; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Access Customer Portal &rarr;
      </a>
    </div>
  ` : `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(customerName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Thank you for submitting your Customer Enrollment application. Following administrative scrutiny, your application requires clarification or has been returned.
    </p>

    <!-- Rejection Card -->
    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">
        Reason for Action
      </div>
      <div style="font-size: 14px; color: #b91c1c; font-weight: 600;">
        ${escapeHtml(reason || 'Submitted details or KYC attachments require update.')}
      </div>
    </div>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; font-size: 13px; color: #475569; margin-bottom: 20px;">
      <div>Application Reference: <strong>${escapeHtml(applicationNo)}</strong></div>
      <div style="margin-top: 4px;">Reviewed Date: ${formatDate(updatedAt)}</div>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      Please log in to your account to review the remarks and update your enrollment form accordingly, or contact our customer support desk.
    </p>

    <div style="text-align: center; margin: 20px 0 10px 0;">
      <a href="https://mmrconstructions.in/login" style="display: inline-block; background-color: #334155; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Update Enrollment Form &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: isApproved ? 'Customer Enrollment Approved' : 'Customer Enrollment Update',
    badgeText: isApproved ? 'Approved' : 'Action Required',
    badgeColor: isApproved ? '#16a34a' : '#dc2626',
    referenceId: applicationNo,
    contentHtml,
  });
}

// ─────────────────────────────────────────────────────────────
// 2. ASSOCIATE PARTNER STATUS TEMPLATES
// ─────────────────────────────────────────────────────────────

export function generateAssociateStatusEmailHtml(data = {}) {
  const {
    associateName = 'Associate Partner',
    associateId = '—',
    memberId = null,
    status = 'approved',
    reason = null,
    approvedBy = 'Executive Management',
    updatedAt = new Date(),
  } = data;

  const isApproved = ['approved', 'active', 'completed'].includes(String(status).toLowerCase());

  const contentHtml = isApproved ? `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(associateName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Welcome to the MMR Leadership Network! Your Associate Partner enrollment has been officially <strong>approved</strong> and your partnership credentials are now fully active.
    </p>

    <!-- Associate Card -->
    <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #166534; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Associate Credentials
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Associate ID:</td>
          <td width="60%"><strong>${escapeHtml(associateId)}</strong></td>
        </tr>
        ${memberId ? `
        <tr>
          <td style="color: #64748b;">Member Code:</td>
          <td><span style="display: inline-block; background-color: #fef08a; color: #854d0e; font-weight: 700; padding: 2px 8px; border-radius: 4px;">${escapeHtml(memberId)}</span></td>
        </tr>
        ` : ''}
        <tr>
          <td style="color: #64748b;">Partnership Status:</td>
          <td><strong style="color: #16a34a;">Active Partner</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Approved By:</td>
          <td>${escapeHtml(approvedBy)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Activation Date:</td>
          <td>${formatDate(updatedAt)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      As an Associate Leader, you can now register direct team members (up to 10 slots), monitor network sales volume, download your official Associate ID Card, and withdraw earned commissions.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/associate/portal" style="display: inline-block; background-color: #155724; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Open Associate Network Portal &rarr;
      </a>
    </div>
  ` : `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(associateName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Your Associate Partner enrollment has been reviewed by the administration. Regrettably, your enrollment could not be approved at this time.
    </p>

    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">
        Review Reason
      </div>
      <div style="font-size: 14px; color: #b91c1c; font-weight: 600;">
        ${escapeHtml(reason || 'KYC verification criteria not satisfied.')}
      </div>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      If you believe this is an error or wish to provide updated documents, please contact your sponsor or the MMR administrative team.
    </p>
  `;

  return renderEmailShell({
    title: isApproved ? 'Associate Partner Approved' : 'Associate Partner Status Update',
    badgeText: isApproved ? 'Approved' : 'Declined',
    badgeColor: isApproved ? '#16a34a' : '#dc2626',
    referenceId: associateId,
    contentHtml,
  });
}

// ─────────────────────────────────────────────────────────────
// 3. TEAM MEMBER STATUS TEMPLATES
// ─────────────────────────────────────────────────────────────

export function generateTeamMemberStatusEmailHtml(data = {}) {
  const {
    teamMemberName = 'Team Member',
    teamMemberUid = '—',
    slotNumber = '—',
    associateName = null,
    status = 'approved',
    reason = null,
    approvedBy = 'Associate Sponsor / Admin',
    updatedAt = new Date(),
  } = data;

  const isApproved = ['approved', 'active'].includes(String(status).toLowerCase());

  const contentHtml = isApproved ? `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(teamMemberName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Congratulations! Your Team Member enrollment has been verified and <strong>approved</strong>. You are now officially allotted an active position in the sales network.
    </p>

    <!-- Team Member Details -->
    <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #166534; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Team Member Allocation Summary
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="42%" style="color: #64748b;">Team Member UID:</td>
          <td width="58%"><strong>${escapeHtml(teamMemberUid)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Assigned Slot Number:</td>
          <td><span style="display: inline-block; background-color: #e0e7ff; color: #3730a3; font-weight: 700; padding: 2px 8px; border-radius: 4px;">Slot #${escapeHtml(slotNumber)}</span></td>
        </tr>
        ${associateName ? `
        <tr>
          <td style="color: #64748b;">Sponsoring Associate:</td>
          <td><strong>${escapeHtml(associateName)}</strong></td>
        </tr>
        ` : ''}
        <tr>
          <td style="color: #64748b;">Authorized By:</td>
          <td>${escapeHtml(approvedBy)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Approval Date:</td>
          <td>${formatDate(updatedAt)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      You can now log in using your registered mobile number and password, introduce clients to MMR plots, earn high sales commissions, and track payouts directly in your wallet.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/team-member/dashboard" style="display: inline-block; background-color: #0b5345; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Go to Team Member Dashboard &rarr;
      </a>
    </div>
  ` : `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(teamMemberName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Your Team Member enrollment request has been updated to <strong>${escapeHtml(status)}</strong>.
    </p>

    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">
        Status Note
      </div>
      <div style="font-size: 14px; color: #b91c1c; font-weight: 600;">
        ${escapeHtml(reason || 'Enrollment slot could not be finalized.')}
      </div>
    </div>
  `;

  return renderEmailShell({
    title: isApproved ? 'Team Member Approved & Slot Confirmed' : 'Team Member Status Update',
    badgeText: isApproved ? 'Slot Confirmed' : 'Update',
    badgeColor: isApproved ? '#16a34a' : '#dc2626',
    referenceId: teamMemberUid,
    contentHtml,
  });
}

// ─────────────────────────────────────────────────────────────
// 4. INVESTOR ACCOUNT & KYC STATUS TEMPLATES
// ─────────────────────────────────────────────────────────────

export function generateInvestorStatusEmailHtml(data = {}) {
  const {
    investorName = 'Investor',
    investorId = '—',
    status = 'approved',
    reason = null,
    approvedBy = 'Investor Relations Desk',
    updatedAt = new Date(),
  } = data;

  const isApproved = ['approved', 'active', 'completed'].includes(String(status).toLowerCase());

  const contentHtml = isApproved ? `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(investorName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      We are delighted to confirm that your <strong>Investor Account &amp; KYC Verification</strong> has been successfully approved by MMR Constructions.
    </p>

    <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #166534; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Investor Verification Overview
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Investor ID:</td>
          <td width="60%"><strong>#${escapeHtml(investorId)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Account Status:</td>
          <td><strong style="color: #16a34a;">Verified &amp; Active</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Authorized By:</td>
          <td>${escapeHtml(approvedBy)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Verified Timestamp:</td>
          <td>${formatDate(updatedAt)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      Your Investor Portfolio is now operational. You can deposit investment capital, subscribe to prime real-estate yield opportunities, and track dividends in your Investor Wallet.
    </p>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/investor/dashboard" style="display: inline-block; background-color: #b45309; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Open Investor Dashboard &rarr;
      </a>
    </div>
  ` : `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(investorName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Your Investor KYC / Account verification has been declined following compliance review.
    </p>

    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">
        Compliance Remark
      </div>
      <div style="font-size: 14px; color: #b91c1c; font-weight: 600;">
        ${escapeHtml(reason || 'Bank details or KYC documentation requires resubmission.')}
      </div>
    </div>
  `;

  return renderEmailShell({
    title: isApproved ? 'Investor Account Verified' : 'Investor Account Status Update',
    badgeText: isApproved ? 'KYC Verified' : 'Action Required',
    badgeColor: isApproved ? '#16a34a' : '#dc2626',
    referenceId: `#${investorId}`,
    contentHtml,
  });
}

// ─────────────────────────────────────────────────────────────
// 5. INVESTOR DEPOSIT REQUEST & STATUS TEMPLATES
// ─────────────────────────────────────────────────────────────

export function generateInvestorDepositRequestEmailHtml(data = {}) {
  const {
    investorName = 'Investor',
    depositId = '—',
    amount = 0,
    paymentMethod = 'Bank Transfer',
    transactionReference = '—',
    requestedAt = new Date(),
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(investorName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Thank you for your fund deposit request with MMR Constructions. We have received your deposit confirmation and proof of payment.
    </p>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #0284c7; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">
        Deposit Details
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Deposit Reference:</td>
          <td width="60%"><strong>${escapeHtml(depositId)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Deposit Amount:</td>
          <td><strong style="color: #0369a1; font-size: 16px;">${formatCurrency(amount)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Payment Method:</td>
          <td>${escapeHtml(paymentMethod)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Bank UTR / Txn No:</td>
          <td><code>${escapeHtml(transactionReference)}</code></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Status:</td>
          <td><span style="display: inline-block; background-color: #e0f2fe; color: #0369a1; font-weight: 700; padding: 2px 8px; border-radius: 4px;">Under Finance Verification</span></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Date:</td>
          <td>${formatDate(requestedAt)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      Once our bank reconciliation team validates the credit in the company account, the funds will be instantly reflected in your Investor Wallet.
    </p>
  `;

  return renderEmailShell({
    title: 'Deposit Request Received',
    badgeText: 'Verification Pending',
    badgeColor: '#0284c7',
    referenceId: depositId,
    contentHtml,
  });
}

export function generateInvestorDepositAdminEmailHtml(data = {}) {
  const {
    investorName = 'Investor',
    investorId = '—',
    depositId = '—',
    amount = 0,
    paymentMethod = 'Bank Transfer',
    transactionReference = '—',
    requestedAt = new Date(),
  } = data;

  const contentHtml = `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      <strong>Action Required:</strong> A new investor fund deposit has been submitted and awaits bank verification.
    </p>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size: 13px; color: #334155;">
        <tr>
          <td width="40%" style="color: #64748b;">Investor:</td>
          <td width="60%"><strong>${escapeHtml(investorName)}</strong> (ID #${escapeHtml(investorId)})</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Deposit Amount:</td>
          <td><strong style="color: #0369a1; font-size: 16px;">${formatCurrency(amount)}</strong></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Payment Method:</td>
          <td>${escapeHtml(paymentMethod)}</td>
        </tr>
        <tr>
          <td style="color: #64748b;">Transaction UTR:</td>
          <td><code>${escapeHtml(transactionReference)}</code></td>
        </tr>
        <tr>
          <td style="color: #64748b;">Submitted At:</td>
          <td>${formatDate(requestedAt)}</td>
        </tr>
      </table>
    </div>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/admin/investor-deposits" style="display: inline-block; background-color: #0e3b1c; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        Review &amp; Credit Deposit in Admin Panel &rarr;
      </a>
    </div>
  `;

  return renderEmailShell({
    title: 'Admin Alert: New Investor Deposit',
    badgeText: 'Deposit Verification',
    badgeColor: '#0284c7',
    referenceId: depositId,
    contentHtml,
  });
}

export function generateInvestorDepositStatusEmailHtml(data = {}) {
  const {
    investorName = 'Investor',
    depositId = '—',
    amount = 0,
    status = 'approved',
    adminRemarks = null,
    updatedBalance = 0,
    approvedAt = new Date(),
  } = data;

  const isApproved = String(status).toLowerCase() === 'approved';

  const contentHtml = isApproved ? `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(investorName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Great news! Your deposit of <strong>${formatCurrency(amount)}</strong> has been verified by the bank and officially credited to your <strong>Investor Wallet</strong>.
    </p>

    <!-- Credit Highlight Box -->
    <div style="background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%); border: 2px dashed #059669; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #047857; text-transform: uppercase; letter-spacing: 1px;">
        Funds Added Successfully
      </div>
      <div style="font-size: 30px; font-weight: 800; color: #065f46; margin: 6px 0;">
        +${formatCurrency(amount)}
      </div>
      <div style="font-size: 13px; color: #047857;">
        Updated Wallet Balance: <strong>${formatCurrency(updatedBalance)}</strong>
      </div>
    </div>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; font-size: 13px; color: #475569; margin-bottom: 20px;">
      <div>Deposit Reference: <strong>${escapeHtml(depositId)}</strong></div>
      <div style="margin-top: 4px;">Approval Date: ${formatDate(approvedAt)}</div>
    </div>

    <div style="text-align: center; margin: 24px 0 10px 0;">
      <a href="https://mmrconstructions.in/investor/wallet" style="display: inline-block; background-color: #059669; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; text-decoration: none; border-radius: 6px;">
        View Investor Wallet &rarr;
      </a>
    </div>
  ` : `
    <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-top: 0;">
      Dear <strong>${escapeHtml(investorName)}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #334155;">
      Your deposit request for <strong>${formatCurrency(amount)}</strong> could not be verified and has been declined.
    </p>

    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 12px; font-weight: 700; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">
        Reason for Decline
      </div>
      <div style="font-size: 14px; color: #b91c1c; font-weight: 600;">
        ${escapeHtml(adminRemarks || 'Bank transaction record or UTR could not be reconciled with company bank account.')}
      </div>
    </div>
  `;

  return renderEmailShell({
    title: isApproved ? 'Investor Deposit Approved & Credited' : 'Investor Deposit Declined',
    badgeText: isApproved ? 'Deposit Credited' : 'Declined',
    badgeColor: isApproved ? '#16a34a' : '#dc2626',
    referenceId: depositId,
    contentHtml,
  });
}

