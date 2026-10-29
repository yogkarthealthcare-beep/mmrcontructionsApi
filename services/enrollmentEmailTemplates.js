/**
 * MMR Constructions & Developers Private Limited
 * Standalone Form-Matching Enrollment Email Templates
 * 
 * Provides responsive, email-client-compatible HTML email templates
 * matching the visual design, branding, color scheme, typography, and section
 * hierarchy of all 4 MMR enrollment forms:
 * 1. Customer Enrollment
 * 2. Associate Enrollment
 * 3. Investor Enrollment
 * 4. Team Member Enrollment
 */

// Helper to escape HTML characters safely
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper to format values with fallback dash
function val(value, fallback = '—') {
  if (value === null || value === undefined || String(value).trim() === '' || String(value).trim() === 'null') {
    return `<span style="color:#94a3b8;">${fallback}</span>`;
  }
  return escapeHtml(String(value).trim());
}

// Helper to format date in Indian locale (DD/MM/YYYY)
function formatDate(d) {
  if (!d) return '<span style="color:#94a3b8;">—</span>';
  try {
    const parsed = new Date(d);
    if (isNaN(parsed.getTime())) return escapeHtml(String(d));
    const day = String(parsed.getDate()).padStart(2, '0');
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const year = parsed.getFullYear();
    return `${day}/${month}/${year}`;
  } catch {
    return escapeHtml(String(d));
  }
}

// Helper to format Indian Currency
function formatCurrency(amount) {
  if (amount === null || amount === undefined || amount === '' || isNaN(Number(amount))) {
    return '<span style="color:#94a3b8;">—</span>';
  }
  try {
    const num = Number(amount);
    return `&#8377; ${num.toLocaleString('en-IN')}`;
  } catch {
    return `&#8377; ${amount}`;
  }
}

// Common Company Header Box
function renderCompanyHeader(options = {}) {
  const {
    headerGradient = 'linear-gradient(135deg, #14532d 0%, #1f6e3a 100%)',
    accentBorderColor = '#c9a84c',
    applicationId = '',
    applicationLabel = 'Application No',
    formDate = ''
  } = options;

  return `
  <!-- Company Brand Header -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${headerGradient}; border-top-left-radius:8px; border-top-right-radius:8px; border-bottom:3px solid ${accentBorderColor};">
    <tr>
      <td style="padding:20px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td valign="middle" width="56" style="padding-right:16px;">
              <div style="width:52px; height:52px; border-radius:50%; background:#ffffff; text-align:center; line-height:52px; font-family:Arial,sans-serif; font-weight:800; font-size:18px; color:#14532d; letter-spacing:1px; box-shadow:0 2px 6px rgba(0,0,0,0.15);">
                MMR
              </div>
            </td>
            <td valign="middle" align="left">
              <div style="font-family:'Segoe UI',Arial,sans-serif; font-size:17px; font-weight:800; color:#ffffff; line-height:1.25; letter-spacing:0.3px; text-transform:uppercase;">
                M.M.R. CONSTRUCTION &amp; DEVELOPERS
              </div>
              <div style="font-family:'Segoe UI',Arial,sans-serif; font-size:11px; font-weight:700; color:#fef08a; margin-top:2px; letter-spacing:0.8px;">
                PRIVATE LIMITED
              </div>
              <div style="font-family:Arial,sans-serif; font-size:10.5px; color:#e2e8f0; margin-top:4px; line-height:1.4;">
                Head Office: 05, Tribhuvan Khera, Sheshpur Nari | Corporate Office: Unnao, UP 209801
              </div>
            </td>
            <td valign="middle" align="right" style="padding-left:12px;" class="meta-col">
              <table role="presentation" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif; font-size:10px; color:#ffffff; line-height:1.5;">
                <tr><td align="right" style="color:#fef08a; font-weight:bold;">Ph: 9511119879 | 8429823067</td></tr>
                <tr><td align="right" style="color:#ffffff;">GST: 09AATCM6753A1Z5</td></tr>
                <tr><td align="right" style="color:#ffffff;">CIN: U68200UP2025PTC229203</td></tr>
                ${applicationId ? `<tr><td align="right" style="color:#ffffff; font-weight:bold; padding-top:2px;">${escapeHtml(applicationLabel)}: <span style="color:#fef08a;">${escapeHtml(applicationId)}</span></td></tr>` : ''}
                ${formDate ? `<tr><td align="right" style="color:#cbd5e1;">Date: ${escapeHtml(formDate)}</td></tr>` : ''}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;
}

// Common Email Footer
function renderEmailFooter() {
  return `
  <!-- Company Footer -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc; border-top:1px solid #e2e8f0; border-bottom-left-radius:8px; border-bottom-right-radius:8px; margin-top:24px;">
    <tr>
      <td style="padding:20px 24px; text-align:center; font-family:Arial,sans-serif; font-size:11px; color:#64748b; line-height:1.6;">
        <div style="font-weight:bold; color:#0f172a; font-size:12px; margin-bottom:4px;">
          M.M.R. Construction &amp; Developers Private Limited
        </div>
        <div>
          Registered Office: 05, Tribhuvan Khera, Sheshpur Nari, Unnao, Uttar Pradesh - 209801
        </div>
        <div style="margin-top:4px;">
          Helpline: <strong style="color:#14532d;">+91 9511119879</strong> / <strong style="color:#14532d;">+91 7071951011</strong> &nbsp;|&nbsp; 
          Website: <a href="https://mmrconstructions.in" style="color:#1d5aa8; text-decoration:none;">mmrconstructions.in</a> &nbsp;|&nbsp; 
          Email: <a href="mailto:official@mmrconstructions.in" style="color:#1d5aa8; text-decoration:none;">official@mmrconstructions.in</a>
        </div>
        <div style="margin-top:10px; font-size:10px; color:#94a3b8; border-top:1px dashed #cbd5e1; padding-top:8px;">
          यह ईमेल सिस्टम द्वारा स्वचालित रूप से आपकी नामांकन पुष्टि (Enrollment Confirmation) के लिए भेजा गया है। कृपया भविष्य के संदर्भ के लिए इसे सुरक्षित रखें।
        </div>
      </td>
    </tr>
  </table>
  `;
}

// Section Header Bar
function renderSectionBar(title, num = '', accentColor = '#14532d', bgTint = '#eaf4ee') {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px; margin-bottom:10px; border-left:4px solid ${accentColor}; background:${bgTint};">
    <tr>
      <td style="padding:8px 12px; font-family:'Segoe UI',Arial,sans-serif; font-size:13px; font-weight:bold; color:${accentColor}; text-transform:uppercase; letter-spacing:0.4px;">
        ${num ? `<span style="background:${accentColor}; color:#ffffff; padding:2px 7px; border-radius:3px; font-size:11px; margin-right:6px;">${num}</span>` : ''}
        ${escapeHtml(title)}
      </td>
    </tr>
  </table>
  `;
}

// 2-Column or Full-Width Field Row
function renderFieldRow(fields = []) {
  if (fields.length === 1) {
    const f = fields[0];
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px; font-family:Arial,sans-serif; font-size:12px;">
      <tr>
        <td width="28%" style="padding:5px 8px; background:#f8fafc; color:#64748b; font-weight:600; border:1px solid #e2e8f0; vertical-align:top;">
          ${escapeHtml(f.label)}
        </td>
        <td style="padding:5px 10px; background:#ffffff; color:#0f172a; font-weight:500; border:1px solid #e2e8f0; border-left:none; vertical-align:top;">
          ${f.value}
        </td>
      </tr>
    </table>
    `;
  }

  // 2-columns (50% / 50%)
  const f1 = fields[0] || { label: '', value: '' };
  const f2 = fields[1] || { label: '', value: '' };

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px; font-family:Arial,sans-serif; font-size:12px;">
    <tr>
      <td width="22%" style="padding:5px 8px; background:#f8fafc; color:#64748b; font-weight:600; border:1px solid #e2e8f0; vertical-align:top;">
        ${escapeHtml(f1.label)}
      </td>
      <td width="28%" style="padding:5px 10px; background:#ffffff; color:#0f172a; font-weight:500; border:1px solid #e2e8f0; border-left:none; vertical-align:top;">
        ${f1.value}
      </td>
      <td width="22%" style="padding:5px 8px; background:#f8fafc; color:#64748b; font-weight:600; border:1px solid #e2e8f0; border-left:none; vertical-align:top;">
        ${escapeHtml(f2.label)}
      </td>
      <td width="28%" style="padding:5px 10px; background:#ffffff; color:#0f172a; font-weight:500; border:1px solid #e2e8f0; border-left:none; vertical-align:top;">
        ${f2.value}
      </td>
    </tr>
  </table>
  `;
}

// Outer Email Shell wrapper
function wrapEmailShell(titleBanner, contentHtml, companyHeaderHtml) {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MMR Enrollment Confirmation</title>
    <style>
      @media only screen and (max-width: 620px) {
        .email-container { width: 100% !important; }
        .meta-col { display: none !important; }
      }
    </style>
  </head>
  <body style="margin:0; padding:0; background:#edf2f7; font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#edf2f7; padding:20px 10px;">
      <tr>
        <td align="center">
          <table role="presentation" class="email-container" width="660" cellpadding="0" cellspacing="0" style="background:#ffffff; border:1px solid #cbd5e1; border-radius:8px; box-shadow:0 4px 14px rgba(0,0,0,0.06); text-align:left;">
            <tr>
              <td>
                ${companyHeaderHtml}
                ${titleBanner}
                <div style="padding:16px 20px;">
                  ${contentHtml}
                </div>
                ${renderEmailFooter()}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

/* ==========================================================================
   1. CUSTOMER ENROLLMENT EMAIL TEMPLATE
   Matches: src/app/user/customer-enrollment/customer-enrollment.component.html
   ========================================================================== */
export function generateCustomerEnrollmentEmailHtml(data = {}, meta = {}) {
  const appNo = data.application_no || data.applicationNo || meta.applicationNo || '—';
  const formDateStr = formatDate(data.form_date || data.formDate || new Date());

  const companyHeader = renderCompanyHeader({
    headerGradient: 'linear-gradient(135deg, #1b5e20 0%, #2e7d32 100%)',
    accentBorderColor: '#1d5aa8',
    applicationId: appNo,
    applicationLabel: 'Application No',
    formDate: formDateStr
  });

  const titleBanner = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1d5aa8; color:#ffffff; text-align:center;">
    <tr>
      <td style="padding:10px 14px;">
        <div style="font-family:'Segoe UI',Arial,sans-serif; font-size:15px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase;">
          CUSTOMER ENROLLMENT FORM
        </div>
        <div style="font-size:12px; opacity:0.95; margin-top:2px;">
          ग्राहक नामांकन फॉर्म (Official Allotment &amp; Registration Record)
        </div>
      </td>
    </tr>
  </table>
  `;

  // Status Box
  const isFinal = Boolean(data.is_final_submitted || data.isFinalSubmitted);
  const statusBox = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4; border:1px solid #86efac; border-radius:6px; margin-bottom:14px;">
    <tr>
      <td style="padding:10px 14px; font-size:12px; color:#14532d; font-family:Arial,sans-serif;">
        <strong>&#10004; Enrollment Status:</strong> 
        <span style="background:${isFinal ? '#14532d' : '#0369a1'}; color:#ffffff; padding:2px 8px; border-radius:99px; font-size:11px; font-weight:bold; margin-left:6px;">
          ${isFinal ? 'PERMANENTLY FINAL SUBMITTED &amp; LOCKED' : 'DRAFT SUBMITTED (REVIEW MODE)'}
        </span>
        <div style="font-size:11px; color:#475569; margin-top:4px;">
          प्रिय <strong>${escapeHtml(data.applicant_name || data.applicantName || 'Customer')}</strong>, आपका ग्राहक नामांकन सफलतापूर्वक दर्ज कर लिया गया है।
        </div>
      </td>
    </tr>
  </table>
  `;

  // Section 1: Property & Project Details
  const sec1 = renderSectionBar('1. Property & Project Details', '1', '#1d5aa8', '#eff6ff') +
    renderFieldRow([
      { label: 'Project Name', value: val(data.project_name || data.projectName) },
      { label: 'Property Type', value: val(data.property_type || data.propertyType) }
    ]) +
    renderFieldRow([
      { label: 'Plot / Flat No', value: val(data.plot_flat_no || data.plotFlatNo) },
      { label: 'Block / Tower', value: val(data.block_tower || data.blockTower) }
    ]) +
    renderFieldRow([
      { label: 'Size / Area', value: val(data.size_area || data.sizeArea) },
      { label: 'Rate Per Unit', value: formatCurrency(data.rate_per_unit || data.ratePerUnit) }
    ]) +
    renderFieldRow([
      { label: 'Basic Sale Price (BSP)', value: formatCurrency(data.basic_sale_price || data.basicSalePrice) },
      { label: 'PLC / Dev Charges', value: formatCurrency(data.plc_dev_charges || data.plcDevCharges) }
    ]) +
    renderFieldRow([
      { label: 'Total Property Value', value: `<strong style="color:#14532d; font-size:13px;">${formatCurrency(data.total_property_value || data.totalPropertyValue)}</strong>` }
    ]);

  // Section 2: First Applicant Details
  const sec2 = renderSectionBar('2. First Applicant Details', '2', '#14532d', '#f0fdf4') +
    renderFieldRow([
      { label: 'Applicant Full Name', value: `<strong>${val(data.applicant_name || data.applicantName)}</strong>` },
      { label: "Father's / Husband's Name", value: val(data.fh_name || data.fhName) }
    ]) +
    renderFieldRow([
      { label: 'Date of Birth', value: formatDate(data.date_of_birth || data.dob) },
      { label: 'Age', value: val(data.age) }
    ]) +
    renderFieldRow([
      { label: 'Gender', value: val(data.gender) },
      { label: 'Marital Status', value: val(data.marital_status || data.maritalStatus) }
    ]) +
    renderFieldRow([
      { label: 'Nationality', value: val(data.nationality || 'Indian') },
      { label: 'Religion', value: val(data.religion) }
    ]) +
    renderFieldRow([
      { label: 'PAN Card No', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.pan_no || data.pan)}</span>` },
      { label: 'Aadhaar Card No', value: `<span style="font-family:monospace;">${val(data.aadhar_no || data.aadhar)}</span>` }
    ]) +
    renderFieldRow([
      { label: 'Occupation', value: val(data.occupation) },
      { label: 'Mobile No 1', value: `<strong>${val(data.mobile_1 || data.mobile1)}</strong>` }
    ]) +
    renderFieldRow([
      { label: 'Mobile No 2 (Alt)', value: val(data.mobile_2 || data.mobile2) },
      { label: 'Email Address', value: `<a href="mailto:${val(data.email_1 || data.email1)}" style="color:#1d5aa8; text-decoration:none;">${val(data.email_1 || data.email1)}</a>` }
    ]) +
    renderFieldRow([
      { label: 'Present Address', value: `${val(data.present_address || data.presentAddress)}, ${val(data.present_city || data.presentCity)}, ${val(data.present_state_pin || data.presentStatePin)}` }
    ]) +
    renderFieldRow([
      { label: 'Permanent Address', value: `${val(data.permanent_address || data.permanentAddress)}, ${val(data.permanent_city || data.permanentCity)}, ${val(data.permanent_state_pin || data.permanentStatePin)}` }
    ]);

  // Section 3: Co-Applicant Details
  const hasCoApplicant = Boolean(data.co_applicant_name || data.coApplicantName);
  const sec3 = renderSectionBar('3. Co-Applicant Details (if any)', '3', '#14532d', '#f0fdf4') +
    (hasCoApplicant ? (
      renderFieldRow([
        { label: 'Co-Applicant Name', value: `<strong>${val(data.co_applicant_name || data.coApplicantName)}</strong>` },
        { label: "Father's / Husband's Name", value: val(data.co_fh_name || data.coFhName) }
      ]) +
      renderFieldRow([
        { label: 'Relationship with Applicant', value: val(data.co_relation || data.coRelation) },
        { label: 'Date of Birth / Age', value: `${formatDate(data.co_date_of_birth || data.coDob)} (${val(data.co_age || data.coAge)} yrs)` }
      ]) +
      renderFieldRow([
        { label: 'PAN No', value: val(data.co_pan_no || data.coPan) },
        { label: 'Aadhaar No', value: val(data.co_aadhar_no || data.coAadhar) }
      ]) +
      renderFieldRow([
        { label: 'Mobile No', value: val(data.co_mobile || data.coMobile) },
        { label: 'Email Address', value: val(data.co_email || data.coEmail) }
      ])
    ) : `
      <div style="padding:8px 12px; background:#f8fafc; border:1px solid #e2e8f0; font-size:12px; color:#64748b; font-family:Arial,sans-serif; margin-bottom:8px;">
        No Co-Applicant specified / कोई सह-आवेदक नहीं।
      </div>
    `);

  // Section 4: Nominee Details
  const nominees = Array.isArray(data.nominees) ? data.nominees : [];
  let nomineeRowsHtml = '';
  if (nominees.length > 0) {
    nomineeRowsHtml = nominees.map((n, i) => `
      <tr>
        <td style="padding:6px 8px; border:1px solid #cbd5e1; text-align:center;">${i + 1}</td>
        <td style="padding:6px 8px; border:1px solid #cbd5e1; font-weight:600;">${val(n.nominee_name || n.nomineeName)}</td>
        <td style="padding:6px 8px; border:1px solid #cbd5e1;">${val(n.relation || n.nomineeRelation)}</td>
        <td style="padding:6px 8px; border:1px solid #cbd5e1;">${val(n.age_dob || n.nomineeAgeDob)}</td>
        <td style="padding:6px 8px; border:1px solid #cbd5e1;">${val(n.aadhar_no || n.nomineeAadhar)}</td>
      </tr>
    `).join('');
  } else {
    nomineeRowsHtml = `
      <tr>
        <td colspan="5" style="padding:8px; border:1px solid #cbd5e1; text-align:center; color:#94a3b8;">
          No Nominees recorded / कोई नामांकित व्यक्ति नहीं।
        </td>
      </tr>
    `;
  }

  const sec4 = renderSectionBar('4. Nominee Details', '4', '#14532d', '#f0fdf4') + `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-family:Arial,sans-serif; font-size:11.5px; margin-bottom:10px;">
      <thead>
        <tr style="background:#e2e8f0; color:#334155; font-weight:bold;">
          <th width="8%" style="padding:6px 8px; border:1px solid #cbd5e1; text-align:center;">#</th>
          <th width="32%" style="padding:6px 8px; border:1px solid #cbd5e1; text-align:left;">Nominee Name</th>
          <th width="20%" style="padding:6px 8px; border:1px solid #cbd5e1; text-align:left;">Relationship</th>
          <th width="20%" style="padding:6px 8px; border:1px solid #cbd5e1; text-align:left;">Age / DOB</th>
          <th width="20%" style="padding:6px 8px; border:1px solid #cbd5e1; text-align:left;">Aadhaar No</th>
        </tr>
      </thead>
      <tbody>
        ${nomineeRowsHtml}
      </tbody>
    </table>
  `;

  // Section 5: Payment Details
  const sec5 = renderSectionBar('5. Payment Details (Initial Booking Amount)', '5', '#14532d', '#f0fdf4') +
    renderFieldRow([
      { label: 'Booking Amount Paid', value: `<strong style="color:#14532d; font-size:13px;">${formatCurrency(data.booking_amount || data.bookingAmount)}</strong>` },
      { label: 'Amount in Words', value: val(data.booking_amount_words || data.bookingAmountWords) }
    ]) +
    renderFieldRow([
      { label: 'Payment Mode', value: val(data.payment_mode || data.paymentMode) },
      { label: 'Cheque / DD / TXN No', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.txn_cheque_no || data.txnNo)}</span>` }
    ]) +
    renderFieldRow([
      { label: 'Payment Date', value: formatDate(data.txn_date || data.txnDate) },
      { label: 'Drawn Bank & Branch', value: val(data.drawn_bank_branch || data.drawnBankBranch) }
    ]);

  // Section 6: Bank Account Details
  const sec6 = renderSectionBar('6. Bank Account Details (for Refund / Cancellation)', '6', '#14532d', '#f0fdf4') +
    renderFieldRow([
      { label: 'Account Holder Name', value: val(data.acc_holder_name || data.accHolderName) },
      { label: 'Bank & Branch Name', value: val(data.acc_bank_branch || data.accBankBranch) }
    ]) +
    renderFieldRow([
      { label: 'Account Number', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.acc_number || data.accNumber)}</span>` },
      { label: 'IFSC Code', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.ifsc_code || data.ifscCode)}</span>` }
    ]);

  // Section 7: Sponsor / Associate Details
  const sec7 = renderSectionBar('7. Sponsor / Associate Details (मार्गदर्शक विवरण)', '7', '#14532d', '#f0fdf4') +
    renderFieldRow([
      { label: 'Associate Name', value: val(data.associate_name || data.associateName) },
      { label: 'Associate ID / Code', value: `<strong style="color:#0369a1;">${val(data.associate_id || data.associateId)}</strong>` }
    ]) +
    renderFieldRow([
      { label: 'Associate Mobile No', value: val(data.associate_mobile || data.associateMobile) },
      { label: 'Digital Signatory Name', value: val(data.associate_signature_name || data.associateSignatureName) }
    ]);

  const content = `
    ${statusBox}
    ${sec1}
    ${sec2}
    ${sec3}
    ${sec4}
    ${sec5}
    ${sec6}
    ${sec7}
  `;

  return wrapEmailShell(titleBanner, content, companyHeader);
}

/* ==========================================================================
   2. ASSOCIATE ENROLLMENT EMAIL TEMPLATE
   Matches: src/app/associate/enrollment/associate-enrollment-form.component.html
   ========================================================================== */
export function generateAssociateEnrollmentEmailHtml(data = {}, meta = {}) {
  const associateId = data.id || data.associateId || meta.associateId || '—';
  const signDateStr = formatDate(data.sign_date || data.signDate || new Date());

  const companyHeader = renderCompanyHeader({
    headerGradient: 'linear-gradient(135deg, #144a27 0%, #1f6e3a 100%)',
    accentBorderColor: '#2f8f52',
    applicationId: associateId,
    applicationLabel: 'Associate ID',
    formDate: signDateStr
  });

  const titleBanner = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1f6e3a; color:#ffffff; text-align:center;">
    <tr>
      <td style="padding:10px 14px;">
        <div style="font-family:'Segoe UI',Arial,sans-serif; font-size:15px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase;">
          ASSOCIATE ENROLLMENT FORM
        </div>
        <div style="font-size:12px; opacity:0.95; margin-top:2px;">
          आधिकारिक व्यापार सहयोगी नामांकन (Official Channel Partner Agreement Record)
        </div>
      </td>
    </tr>
  </table>
  `;

  // Status Box
  const isFinal = Boolean(data.is_final_submitted || data.isFinalSubmitted);
  const statusBox = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4; border:1px solid #86efac; border-radius:6px; margin-bottom:14px;">
    <tr>
      <td style="padding:10px 14px; font-size:12px; color:#144a27; font-family:Arial,sans-serif;">
        <strong>&#10004; Associate Status:</strong> 
        <span style="background:${isFinal ? '#144a27' : '#0369a1'}; color:#ffffff; padding:2px 8px; border-radius:99px; font-size:11px; font-weight:bold; margin-left:6px;">
          ${isFinal ? 'FINAL SUBMITTED (PENDING OFFICE APPROVAL)' : 'DRAFT ENROLLMENT SUBMITTED'}
        </span>
        <div style="font-size:11px; color:#475569; margin-top:4px;">
          बधाई हो <strong>${escapeHtml(data.full_name || data.fullName || 'Associate')}</strong>! आपका एसोसिएट नामांकन फॉर्म सफलतापूर्वक सबमिट हो चुका है। आपका यूनिक एसोसिएट कोड <strong>${escapeHtml(associateId)}</strong> है।
        </div>
      </td>
    </tr>
  </table>
  `;

  // Section 1: Personal Details
  const sec1 = renderSectionBar('1. Personal Details', '1', '#1f6e3a', '#e8f4ea') +
    renderFieldRow([
      { label: 'Associate Full Name', value: `<strong>${val(data.full_name || data.fullName)}</strong>` },
      { label: 'Date of Birth', value: formatDate(data.dob) }
    ]) +
    renderFieldRow([
      { label: 'Gender', value: val(data.gender) },
      { label: "Father's Name", value: val(data.father_name || data.fatherName) }
    ]) +
    renderFieldRow([
      { label: "Mother's Name", value: val(data.mother_name || data.motherName) },
      { label: "Spouse's Name", value: val(data.spouse_name || data.spouseName) }
    ]) +
    renderFieldRow([
      { label: 'Primary Contact (Mobile)', value: `<strong>${val(data.contact_no_1 || data.contact1)}</strong>` },
      { label: 'Secondary Contact', value: val(data.contact_no_2 || data.contact2) }
    ]) +
    renderFieldRow([
      { label: 'Email ID', value: `<a href="mailto:${val(data.email)}" style="color:#1d5aa8; text-decoration:none;">${val(data.email)}</a>` },
      { label: 'PAN Card No', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.pan_no || data.panNo)}</span>` }
    ]) +
    renderFieldRow([
      { label: 'Aadhaar Card No', value: `<span style="font-family:monospace;">${val(data.aadhar_no || data.aadharNo)}</span>` },
      { label: 'Nationality', value: val(data.nationality || 'Indian') }
    ]) +
    renderFieldRow([
      { label: 'Occupation', value: val(data.occupation) },
      { label: 'Annual Income', value: val(data.annual_income || data.annualIncome) }
    ]) +
    renderFieldRow([
      { label: 'Education Qualification', value: val(data.education) },
      { label: 'Category & Religion', value: `${val(data.category)} / ${val(data.religion)}` }
    ]);

  // Section 2: Address Details
  const permAddr = data.permAddress || data.perm_address || data.address || '';
  const permCity = data.permCity || data.perm_city || data.city || '';
  const permState = data.permState || data.perm_state || data.state || '';
  const permPin = data.permPin || data.perm_pin || data.pin_code || '';

  const localAddr = data.localAddress || data.local_address || '';
  const localCity = data.localCity || data.local_city || '';
  const localState = data.localState || data.local_state || '';
  const localPin = data.localPin || data.local_pin || '';

  const sec2 = renderSectionBar('2. Address Details', '2', '#1f6e3a', '#e8f4ea') +
    renderFieldRow([
      { label: 'Permanent Address', value: `${val(permAddr)}, ${val(permCity)}, ${val(permState)} - ${val(permPin)}` }
    ]) +
    renderFieldRow([
      { label: 'Local / Corr. Address', value: localAddr ? `${val(localAddr)}, ${val(localCity)}, ${val(localState)} - ${val(localPin)}` : 'Same as Permanent Address' }
    ]);

  // Section 3: Bank Details
  const sec3 = renderSectionBar('3. Bank Details (Commission Payouts)', '3', '#1f6e3a', '#e8f4ea') +
    renderFieldRow([
      { label: 'Bank Name', value: val(data.bank_name || data.bankName) },
      { label: 'Branch Name', value: val(data.branch_name || data.branchName) }
    ]) +
    renderFieldRow([
      { label: 'Account Holder Name', value: val(data.acc_holder || data.accHolder) },
      { label: 'Account Number', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.acc_no || data.accNo)}</span>` }
    ]) +
    renderFieldRow([
      { label: 'IFSC Code', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.ifsc)}</span>` },
      { label: 'MICR Code', value: val(data.micr) }
    ]);

  // Section 4: Nominee Details
  const sec4 = renderSectionBar('4. Nominee Details', '4', '#1f6e3a', '#e8f4ea') +
    renderFieldRow([
      { label: 'Nominee Full Name', value: `<strong>${val(data.nominee_name || data.nomineeName)}</strong>` },
      { label: 'Relationship', value: val(data.nominee_relation || data.nomineeRelation) }
    ]) +
    renderFieldRow([
      { label: 'Nominee DOB / Age', value: formatDate(data.nominee_dob || data.nomineeDob) },
      { label: 'Nominee Contact No', value: val(data.nominee_contact || data.nomineeContact) }
    ]) +
    renderFieldRow([
      { label: 'Nominee Address', value: val(data.nominee_address || data.nomineeAddress) }
    ]);

  // Section 5: Sponsor / Introducer Details
  const sec5 = renderSectionBar('5. Sponsor / Introducer Details', '5', '#1f6e3a', '#e8f4ea') +
    renderFieldRow([
      { label: 'Sponsor Name', value: val(data.sponsor_name || data.sponsorName) },
      { label: 'Sponsor Associate ID', value: `<strong style="color:#0369a1;">${val(data.sponsor_id || data.sponsorId)}</strong>` }
    ]) +
    renderFieldRow([
      { label: 'Sponsor Rank / Level', value: val(data.sponsor_rank || data.sponsorRank || 'Team Leader') }
    ]);

  // Section 6: Key Commission & Benefits Undertaking
  const sec6 = renderSectionBar('6. Terms & Benefits Undertaking Summary', '6', '#1f6e3a', '#e8f4ea') + `
  <div style="font-family:Arial,sans-serif; font-size:11px; color:#475569; line-height:1.6; background:#f8fafc; border:1px solid #e2e8f0; padding:10px 14px; border-radius:4px; margin-bottom:8px;">
    <div>&#10004; <strong>Commission Matrix:</strong> 5% direct commission on plot sales, 0.5% team leader passive override.</div>
    <div>&#10004; <strong>Patrolling Allowance:</strong> ₹12,000/month for 72 months upon cumulative 2000 sq. yard sales milestone.</div>
    <div>&#10004; <strong>Accidental Insurance Cover:</strong> ₹3,00,000 nominee relief / 50 sq. yard registered plot during active tenure.</div>
    <div>&#10004; <strong>Legal Declaration:</strong> All sales proceed strictly through company receipts and direct banking accounts.</div>
  </div>
  `;

  const content = `
    ${statusBox}
    ${sec1}
    ${sec2}
    ${sec3}
    ${sec4}
    ${sec5}
    ${sec6}
  `;

  return wrapEmailShell(titleBanner, content, companyHeader);
}

/* ==========================================================================
   3. INVESTOR ENROLLMENT EMAIL TEMPLATE
   Matches: src/app/investor/investor-enrollment/investor-enrollment.component.html
   ========================================================================== */
export function generateInvestorEnrollmentEmailHtml(data = {}, meta = {}) {
  const formNo = data.form_no || data.formNo || meta.formNo || '—';
  const investorEnrollId = data.investor_enrollment_id || data.investorId || meta.investorEnrollmentId || formNo;
  const formDateStr = formatDate(data.form_date || data.formDate || new Date());

  const companyHeader = renderCompanyHeader({
    headerGradient: 'linear-gradient(135deg, #072a17 0%, #0f3d27 100%)',
    accentBorderColor: '#c9a84c',
    applicationId: investorEnrollId,
    applicationLabel: 'Investor ID',
    formDate: formDateStr
  });

  const titleBanner = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f3d27; color:#ffffff; text-align:center; border-bottom:2px solid #c9a84c;">
    <tr>
      <td style="padding:10px 14px;">
        <div style="font-family:'Segoe UI',Arial,sans-serif; font-size:15px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase;">
          INVESTOR ENROLLMENT FORM
        </div>
        <div style="font-size:12px; color:#fef08a; margin-top:2px;">
          निवेशक नामांकन एवं पूँजी सुरक्षा समझौता (High Capital Growth &amp; Buyback Agreement)
        </div>
      </td>
    </tr>
  </table>
  `;

  // Status Box
  const isFinal = Boolean(data.is_final_submitted || data.isFinalSubmit);
  const statusBox = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fefce8; border:1px solid #fde047; border-radius:6px; margin-bottom:14px;">
    <tr>
      <td style="padding:10px 14px; font-size:12px; color:#713f12; font-family:Arial,sans-serif;">
        <strong>&#10004; Investor Status:</strong> 
        <span style="background:${isFinal ? '#854d0e' : '#0369a1'}; color:#ffffff; padding:2px 8px; border-radius:99px; font-size:11px; font-weight:bold; margin-left:6px;">
          ${isFinal ? 'HOLD / PENDING KYC APPROVAL' : 'SUBMITTED (REVIEW STAGE)'}
        </span>
        <div style="font-size:11px; color:#475569; margin-top:4px;">
          आदरणीय <strong>${escapeHtml(data.inv_first_name || data.invFirstName || 'Investor')} ${escapeHtml(data.inv_surname || data.invSurname || '')}</strong>, आपका निवेशक नामांकन सफलतापूर्वक प्राप्त हो चुका है।
        </div>
      </td>
    </tr>
  </table>
  `;

  // Section 1: Personal Particulars
  const invFullName = [data.inv_first_name || data.invFirstName, data.inv_middle_name || data.invMiddleName, data.inv_surname || data.invSurname].filter(Boolean).join(' ');
  const fhFullName = [data.fh_first_name || data.fhFirstName, data.fh_middle_name || data.fhMiddleName, data.fh_surname || data.fhSurname].filter(Boolean).join(' ');

  const sec1 = renderSectionBar('1. Personal Particulars', '1', '#0f3d27', '#f0fdf4') +
    renderFieldRow([
      { label: 'Investor Full Name', value: `<strong>${val(invFullName)}</strong>` },
      { label: "Father's / Husband's Name", value: val(fhFullName) }
    ]) +
    renderFieldRow([
      { label: 'Date of Birth', value: formatDate(data.dob) },
      { label: 'Age', value: `${val(data.age)} Years` }
    ]) +
    renderFieldRow([
      { label: 'Gender', value: val(data.gender) },
      { label: 'Occupation', value: val(data.occupation || data.occupation_other) }
    ]) +
    renderFieldRow([
      { label: 'Mobile Number', value: `<strong>${val(data.mobile)}</strong>` },
      { label: 'Alternate Tel. No', value: val(data.alt_tel || data.altTel) }
    ]) +
    renderFieldRow([
      { label: 'Email Address', value: `<a href="mailto:${val(data.email)}" style="color:#1d5aa8; text-decoration:none;">${val(data.email)}</a>` },
      { label: 'Religion', value: val(data.religion) }
    ]) +
    renderFieldRow([
      { label: 'PAN Card No', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.pan)}</span>` },
      { label: 'Aadhaar Card No', value: `<span style="font-family:monospace;">${val(data.aadhar)}</span>` }
    ]) +
    renderFieldRow([
      { label: 'Permanent Address', value: `${val(data.address)}, ${val(data.city)}, ${val(data.state)} - ${val(data.pin_code || data.pinCode)}` }
    ]) +
    renderFieldRow([
      { label: 'Correspondence Address', value: data.corr_address || data.corrAddress ? `${val(data.corr_address || data.corrAddress)}, ${val(data.corr_city || data.corrCity)}, ${val(data.corr_state || data.corrState)} - ${val(data.corr_pin_code || data.corrPinCode)}` : 'Same as Permanent Address' }
    ]);

  // Section 2: Investment & Bank Details
  const sec2 = renderSectionBar('2. Investment & Bank Details', '2', '#0f3d27', '#f0fdf4') +
    renderFieldRow([
      { label: 'Project Name', value: val(data.project_name || data.projectName) },
      { label: 'Branch Code / Name', value: `${val(data.branch_code || data.branchCode)} / ${val(data.branch_name || data.branchName)}` }
    ]) +
    renderFieldRow([
      { label: 'Investment Amount', value: `<strong style="color:#0f3d27; font-size:13px;">${formatCurrency(data.amount)}</strong>` },
      { label: 'Amount in Words', value: val(data.amount_words || data.amountWords) }
    ]) +
    renderFieldRow([
      { label: 'Mode of Payment', value: val(data.payment_mode || data.paymentMode) },
      { label: 'Cheque / DD / TXN No', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.txn_no || data.txnNo)}</span>` }
    ]) +
    renderFieldRow([
      { label: 'Payment / Cheque Date', value: formatDate(data.txn_date || data.txnDate) },
      { label: 'Bank & Branch Name', value: val(data.bank_branch || data.bankBranch) }
    ]) +
    renderFieldRow([
      { label: 'Account Number', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.account_number || data.accountNumber)}</span>` },
      { label: 'IFSC Code', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.ifsc_code || data.ifscCode)}</span>` }
    ]);

  // Section 3: Nominee Details
  let rawNominees = data.nominees;
  if (typeof rawNominees === 'string') {
    try { rawNominees = JSON.parse(rawNominees); } catch { rawNominees = []; }
  }
  const nominees = Array.isArray(rawNominees) ? rawNominees : [];

  let nomineeRowsHtml = '';
  if (nominees.length > 0) {
    nomineeRowsHtml = nominees.map((n, i) => `
      <tr>
        <td style="padding:6px 8px; border:1px solid #cbd5e1; text-align:center;">${i + 1}</td>
        <td style="padding:6px 8px; border:1px solid #cbd5e1; font-weight:600;">${val(n.name || n.nomineeName)}</td>
        <td style="padding:6px 8px; border:1px solid #cbd5e1;">${val(n.relationship || n.nomineeRelationship)}</td>
        <td style="padding:6px 8px; border:1px solid #cbd5e1;">${val(n.age || n.nomineeAge)}</td>
        <td style="padding:6px 8px; border:1px solid #cbd5e1; font-weight:bold; color:#0f3d27;">${val(n.proportion || n.nomineeProportion)}%</td>
      </tr>
    `).join('');
  } else {
    nomineeRowsHtml = `
      <tr>
        <td colspan="5" style="padding:8px; border:1px solid #cbd5e1; text-align:center; color:#94a3b8;">
          No Nominees recorded / कोई नामांकित व्यक्ति नहीं।
        </td>
      </tr>
    `;
  }

  const sec3 = renderSectionBar('3. Nominee Details', '3', '#0f3d27', '#f0fdf4') + `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-family:Arial,sans-serif; font-size:11.5px; margin-bottom:10px;">
      <thead>
        <tr style="background:#e2e8f0; color:#334155; font-weight:bold;">
          <th width="8%" style="padding:6px 8px; border:1px solid #cbd5e1; text-align:center;">#</th>
          <th width="34%" style="padding:6px 8px; border:1px solid #cbd5e1; text-align:left;">Nominee Name</th>
          <th width="24%" style="padding:6px 8px; border:1px solid #cbd5e1; text-align:left;">Relationship</th>
          <th width="16%" style="padding:6px 8px; border:1px solid #cbd5e1; text-align:left;">Age</th>
          <th width="18%" style="padding:6px 8px; border:1px solid #cbd5e1; text-align:left;">Proportion (%)</th>
        </tr>
      </thead>
      <tbody>
        ${nomineeRowsHtml}
      </tbody>
    </table>
  `;

  // Section 4: Declaration & Signatures
  const sec4 = renderSectionBar('4. Declaration & Specimen Signatures', '4', '#0f3d27', '#f0fdf4') +
    renderFieldRow([
      { label: 'Place of Signing', value: val(data.decl_place || data.declPlace) },
      { label: 'Date of Signing', value: formatDate(data.decl_date || data.declDate) }
    ]) +
    renderFieldRow([
      { label: 'Sole / First Applicant Name', value: val(data.first_applicant_name || data.firstApplicantName || invFullName) },
      { label: 'Joint Applicant Name', value: val(data.joint_applicant_name || data.jointApplicantName || 'None') }
    ]);

  const content = `
    ${statusBox}
    ${sec1}
    ${sec2}
    ${sec3}
    ${sec4}
  `;

  return wrapEmailShell(titleBanner, content, companyHeader);
}

/* ==========================================================================
   4. TEAM MEMBER ENROLLMENT EMAIL TEMPLATE
   Matches: src/app/associate/team-member-enrollment/team-member-enrollment.component.html
   ========================================================================== */
export function generateTeamMemberEnrollmentEmailHtml(data = {}, meta = {}) {
  const memberUid = data.team_member_uid || meta.teamMemberUid || '—';
  const slotNum = data.slot_number || meta.slotNumber || '—';
  const createdDateStr = formatDate(data.created_at || new Date());

  const companyHeader = renderCompanyHeader({
    headerGradient: 'linear-gradient(135deg, #0b5345 0%, #1b5e20 60%, #0d47a1 100%)',
    accentBorderColor: '#c9a84c',
    applicationId: memberUid,
    applicationLabel: 'Team Member ID',
    formDate: createdDateStr
  });

  const titleBanner = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b5345; color:#ffffff; text-align:center;">
    <tr>
      <td style="padding:10px 14px;">
        <div style="font-family:'Segoe UI',Arial,sans-serif; font-size:15px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase;">
          TEAM MEMBER ENROLLMENT FORM
        </div>
        <div style="font-size:12px; color:#fef08a; margin-top:2px;">
          टीम सदस्य नामांकन एवं कोड ऑफ़ कंडक्ट स्वीकृति (Direct Sales Executive)
        </div>
      </td>
    </tr>
  </table>
  `;

  // Status Box
  const isFinal = Boolean(data.is_final_submitted);
  const statusBox = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4; border:1px solid #86efac; border-radius:6px; margin-bottom:14px;">
    <tr>
      <td style="padding:10px 14px; font-size:12px; color:#0b5345; font-family:Arial,sans-serif;">
        <strong>&#10004; Team Member Status:</strong> 
        <span style="background:${isFinal ? '#0b5345' : '#0369a1'}; color:#ffffff; padding:2px 8px; border-radius:99px; font-size:11px; font-weight:bold; margin-left:6px;">
          ${isFinal ? 'PERMANENTLY FINAL SUBMITTED &amp; LOCKED' : 'DRAFT SUBMITTED (REVIEW STAGE)'}
        </span>
        <div style="font-size:11px; color:#475569; margin-top:4px;">
          बधाई हो <strong>${escapeHtml(data.full_name || 'Team Member')}</strong>! आपका टीम सदस्य नामांकन स्लॉट <strong>#${escapeHtml(String(slotNum))}</strong> में सफलतापूर्वक दर्ज कर लिया गया है।
        </div>
      </td>
    </tr>
  </table>
  `;

  // Section A: Associate & Personal Details
  const secA = renderSectionBar('Section A - Associate & Personal Details', 'A', '#0b5345', '#ecfdf5') +
    renderFieldRow([
      { label: 'Sponsoring Associate ID', value: `<strong style="color:#0369a1;">${val(data.associate_id)}</strong>` },
      { label: 'Sponsoring Associate Name', value: `<strong>${val(data.associate_name)}</strong>` }
    ]) +
    renderFieldRow([
      { label: 'Enrolled Slot Number', value: `<span style="background:#fef08a; color:#854d0e; padding:1px 6px; border-radius:3px; font-weight:bold;">Slot #${val(slotNum)}</span>` },
      { label: 'Team Member Full Name', value: `<strong>${val(data.full_name)}</strong>` }
    ]) +
    renderFieldRow([
      { label: "Father's / Husband's Name", value: val(data.father_husband_name) },
      { label: 'Date of Birth', value: formatDate(data.date_of_birth) }
    ]) +
    renderFieldRow([
      { label: 'Gender', value: val(data.gender) },
      { label: 'Aadhaar Card No', value: `<span style="font-family:monospace;">${val(data.aadhar_no)}</span>` }
    ]) +
    renderFieldRow([
      { label: 'PAN Card No', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.pan_no)}</span>` },
      { label: 'Mobile Number', value: `<strong>${val(data.mobile_no)}</strong>` }
    ]) +
    renderFieldRow([
      { label: 'Email ID', value: `<a href="mailto:${val(data.email_id)}" style="color:#1d5aa8; text-decoration:none;">${val(data.email_id)}</a>` },
      { label: 'Full Residential Address', value: val(data.full_address) }
    ]);

  // Section B: Nominee Details
  const secB = renderSectionBar('Section B - Nominee Details', 'B', '#0b5345', '#ecfdf5') +
    renderFieldRow([
      { label: 'Nominee Full Name', value: `<strong>${val(data.nominee_name)}</strong>` },
      { label: 'Relationship', value: val(data.nominee_relation) }
    ]) +
    renderFieldRow([
      { label: 'Nominee Age / DOB', value: val(data.nominee_age_dob) },
      { label: 'Nominee Contact No', value: val(data.nominee_contact_no) }
    ]);

  // Section C: Bank Account Details
  const secC = renderSectionBar('Section C - Bank Account Details (Commission Settlements)', 'C', '#0b5345', '#ecfdf5') +
    renderFieldRow([
      { label: 'Bank Name', value: val(data.bank_name) },
      { label: 'Branch Name', value: val(data.branch_name) }
    ]) +
    renderFieldRow([
      { label: 'Account Number', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.account_no)}</span>` },
      { label: 'IFSC Code', value: `<span style="font-family:monospace; font-weight:bold;">${val(data.ifsc_code)}</span>` }
    ]);

  // Section D: Declaration & Code of Conduct
  const secD = renderSectionBar('Section D - Declaration & Signatures Undertaking', 'D', '#0b5345', '#ecfdf5') +
    renderFieldRow([
      { label: 'Code of Conduct Accepted', value: data.declaration_accepted ? '&#10004; Yes (Agreed to MMR Rules & Direct Sales Guidelines)' : 'Pending' },
      { label: 'Digital Signatures', value: 'Recorded on file with timestamp' }
    ]);

  const content = `
    ${statusBox}
    ${secA}
    ${secB}
    ${secC}
    ${secD}
  `;

  return wrapEmailShell(titleBanner, content, companyHeader);
}

