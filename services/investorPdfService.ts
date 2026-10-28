import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import sql from "../db.js";
import { getStorageRoot } from "./fileStorage.service.js";
import { resolveImageBuffer, drawPhotoBoxWithBuffer, drawSignatureBoxWithBuffer } from "./pdfImageHelper.js";

// Helper to draw MMR header on each page
function drawHeader(doc: any, enrollmentId: string, formDate: string) {
  const brandColor = "#14532d";

  // Green header rectangle
  doc.rect(40, 20, 515, 60).fill(brandColor);

  // Logo: White circle with green "MMR" text
  doc.fillColor("#ffffff").circle(75, 50, 20).fill();
  doc.fillColor(brandColor).fontSize(10).font("Helvetica-Bold").text("MMR", 63, 46);

  // Company Name
  doc.fillColor("#ffffff").fontSize(13).font("Helvetica-Bold").text("M.M.R. CONSTRUCTION & DEVELOPERS PRIVATE", 110, 30);
  doc.text("LIMITED", 110, 44);

  // Subtext
  doc.fontSize(7).font("Helvetica").text("Head Office: 05, Tribhuvan Khera, Sheshpur Nari", 110, 58);
  doc.text("Corporate Office: Unnao, Uttar Pradesh, India 209801", 110, 68);

  // Metadata Box on Right
  doc.fillColor("#ffffff").fontSize(7).font("Helvetica");
  doc.text("Ph No. 9511119879 | 8429823067", 380, 26, { align: "right", width: 170 });
  doc.text("GST No. 09AATCM6753A1Z5", 380, 35, { align: "right", width: 170 });
  doc.text("CIN No. U68200UP2025PTC229203", 380, 44, { align: "right", width: 170 });
  doc.text(`Enrollment ID: ${enrollmentId || "—"}`, 380, 53, { align: "right", width: 170 });
  doc.text(`Date: ${formDate || "—"}`, 380, 62, { align: "right", width: 170 });
}

// Helper to draw MMR footer on each page
function drawFooter(doc: any, pageNum: number, totalPages: number) {
  doc.fillColor("#64748b").fontSize(7).font("Helvetica");
  doc.text("Website: https://mmrconstructions.in/ | Email: mmrconstructions@hotmail.com", 40, 770, { align: "left" });
  doc.text(`Page ${pageNum} of ${totalPages}`, 400, 770, { align: "right", width: 155 });
}

// Helper to draw section title bars
function drawSectionTitle(doc: any, title: string, y: number) {
  doc.rect(40, y, 515, 18).fill("#14532d");
  doc.fillColor("#ffffff").fontSize(9).font("Helvetica-Bold").text(title, 48, y + 4);
}

// Helper to draw dotted fields
function drawField(doc: any, label: string, value: any, x: number, y: number, width: number, labelWidth = 120) {
  doc.fillColor("#1e293b").fontSize(8.5).font("Helvetica-Bold").text(label, x, y, { width: labelWidth });

  const valueX = x + labelWidth + 5;
  const valueWidth = width - labelWidth - 5;

  const displayVal = (value !== null && value !== undefined && String(value).trim() !== "") ? String(value) : "—";
  doc.fillColor("#0f172a").font("Helvetica").text(displayVal, valueX, y, { width: valueWidth });

  // Dotted underline
  const lineY = y + 10;
  doc.lineWidth(0.5).strokeColor("#cbd5e1").dash(2, { space: 2 }).moveTo(valueX, lineY).lineTo(x + width, lineY).stroke().undash();
}

// Helper to draw checkboxes with clean vector checkmark
function drawCheckbox(doc: any, text: string, x: number, y: number, checked = true) {
  doc.lineWidth(1).strokeColor("#14532d").rect(x, y, 11, 11).stroke();
  if (checked) {
    doc.lineWidth(1.6)
      .strokeColor("#14532d")
      .moveTo(x + 2.5, y + 5.5)
      .lineTo(x + 4.8, y + 8.5)
      .lineTo(x + 9, y + 2.5)
      .stroke();
  }
  doc.fillColor("#1e293b").fontSize(8).font("Helvetica").text(text, x + 18, y + 1, { width: 488 });
}

export async function generateInvestorPdf(id: string): Promise<Buffer> {
  const rawId = String(id || "").trim();
  const numId = Number(rawId) || 0;

  // Comprehensive lookup: supports UUID, integer id, investor_id, investor_enrollment_id, form_no, or user member_id
  const [enrollment] = await sql`
    SELECT ie.*,
           iu.member_id AS user_member_id,
           iu.full_name AS user_full_name,
           iu.profile_picture_url AS user_photo_url,
           iu.mobile_number AS user_mobile,
           iu.email AS user_email
    FROM investor_enrollments ie
    LEFT JOIN investor_users iu ON ie.investor_id = iu.id
    WHERE (ie.id::text = ${rawId})
       OR (ie.investor_id = ${numId} AND ${numId} > 0)
       OR (ie.investor_enrollment_id = ${rawId})
       OR (ie.form_no = ${rawId})
       OR (iu.member_id = ${rawId})
    ORDER BY ie.created_at DESC
    LIMIT 1
  `;

  if (!enrollment) {
    throw new Error(`Investor enrollment with ID "${id}" not found.`);
  }

  const enrollmentId = enrollment.investor_enrollment_id || enrollment.user_member_id || enrollment.form_no || "—";
  const formDateStr = enrollment.form_date ? new Date(enrollment.form_date).toLocaleDateString("en-IN") : "";
  const dobStr = enrollment.dob ? new Date(enrollment.dob).toLocaleDateString("en-IN") : "";
  const txnDateStr = enrollment.txn_date ? new Date(enrollment.txn_date).toLocaleDateString("en-IN") : "";
  const declDateStr = enrollment.decl_date ? new Date(enrollment.decl_date).toLocaleDateString("en-IN") : "";

  // Pre-fetch investor photo and signatures asynchronously with fallbacks
  const photoSource = enrollment.photo_url || enrollment.user_photo_url || null;
  const sigFirstSource = enrollment.signature_first_url || enrollment.signature_url || null;
  const sigJointSource = enrollment.signature_joint_url || null;

  const [photoInvestorBuf, sigFirstBuf, sigJointBuf] = await Promise.all([
    resolveImageBuffer(photoSource),
    resolveImageBuffer(sigFirstSource),
    resolveImageBuffer(sigJointSource)
  ]);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err: any) => reject(err));

    const totalPages = 3;

    // ─────────────────────────────────────────────────────────────────
    // PAGE 1: Personal & Address Details
    // ─────────────────────────────────────────────────────────────────
    drawHeader(doc, enrollmentId, formDateStr);

    doc.fillColor("#14532d").fontSize(13).font("Helvetica-Bold").text("INVESTOR ENROLLMENT FORM", 40, 105, { align: "center", width: 515 });

    // Photo box top-right
    drawPhotoBoxWithBuffer(doc, "investor", 475, 130, photoInvestorBuf, 80, 100);

    drawSectionTitle(doc, "Office Metadata", 130);
    let y = 156;
    drawField(doc, "Form No.:", enrollment.form_no, 40, y, 200, 75);
    drawField(doc, "Form Date:", formDateStr, 250, y, 215, 75);

    y += 22;
    drawField(doc, "Branch Code:", enrollment.branch_code, 40, y, 200, 75);
    drawField(doc, "Branch Name:", enrollment.branch_name, 250, y, 215, 75);

    y += 22;
    drawField(doc, "Investor ID / Code:", enrollmentId, 40, y, 425, 120);

    y += 22;
    drawField(doc, "Project Name:", enrollment.project_name, 40, y, 425, 120);

    y += 26;
    drawSectionTitle(doc, "1. Personal Details", y);

    const fullName = [enrollment.inv_first_name, enrollment.inv_middle_name, enrollment.inv_surname].filter(Boolean).join(" ").trim()
      || enrollment.first_applicant_name
      || enrollment.user_full_name
      || "—";

    const fhName = [enrollment.fh_first_name, enrollment.fh_middle_name, enrollment.fh_surname].filter(Boolean).join(" ").trim() || "—";

    y += 22;
    drawField(doc, "Full Name (only Adult):", fullName, 40, y, 515, 125);

    y += 22;
    drawField(doc, "Father's / Husband's Name:", fhName, 40, y, 515, 150);

    y += 22;
    drawField(doc, "Date of Birth:", dobStr, 40, y, 250, 90);
    drawField(doc, "Age:", String(enrollment.age || ""), 300, y, 255, 60);

    y += 22;
    drawField(doc, "Gender:", enrollment.gender || "M", 40, y, 250, 90);
    drawField(doc, "Occupation:", enrollment.occupation === 'Other' ? enrollment.occupation_other : (enrollment.occupation || "—"), 300, y, 255, 100);

    y += 22;
    drawField(doc, "Religion:", enrollment.religion || "—", 40, y, 250, 90);
    drawField(doc, "Nationality:", "Indian", 300, y, 255, 100);

    y += 22;
    drawField(doc, "Permanent Address:", enrollment.address, 40, y, 515, 120);

    y += 22;
    drawField(doc, "City / District:", enrollment.city, 40, y, 250, 90);
    drawField(doc, "State:", enrollment.state, 300, y, 255, 60);

    y += 22;
    drawField(doc, "Pin Code:", enrollment.pin_code, 40, y, 250, 90);
    drawField(doc, "Alt Telephone:", enrollment.alt_tel, 300, y, 255, 100);

    y += 22;
    const corrAddr = (enrollment.corr_address && String(enrollment.corr_address).trim()) ? enrollment.corr_address : "Same as Permanent Address";
    drawField(doc, "Correspondence Address:", corrAddr, 40, y, 515, 135);

    y += 22;
    drawField(doc, "Mobile Number:", enrollment.mobile || enrollment.user_mobile, 40, y, 250, 90);
    drawField(doc, "Email ID:", enrollment.email || enrollment.user_email, 300, y, 255, 60);

    y += 22;
    drawField(doc, "PAN Card Number:", enrollment.pan, 40, y, 250, 90);
    drawField(doc, "Aadhar Card Number:", enrollment.aadhar, 300, y, 255, 100);

    drawFooter(doc, 1, totalPages);

    // ─────────────────────────────────────────────────────────────────
    // PAGE 2: Payment Details, Bank Details & Nominees
    // ─────────────────────────────────────────────────────────────────
    doc.addPage();
    drawHeader(doc, enrollmentId, formDateStr);

    drawSectionTitle(doc, "2. Investment & Payment Details", 110);
    y = 138;
    const amountStr = enrollment.amount ? `Rs. ${Number(enrollment.amount).toLocaleString("en-IN")}` : "—";
    drawField(doc, "Amount Paid (INR):", amountStr, 40, y, 515, 120);

    y += 22;
    drawField(doc, "Amount in Words:", enrollment.amount_words, 40, y, 515, 120);

    y += 22;
    drawField(doc, "Payment Mode:", enrollment.payment_mode, 40, y, 250, 90);
    drawField(doc, "Cheque / DD / Txn No.:", enrollment.txn_no, 300, y, 255, 130);

    y += 22;
    drawField(doc, "Transaction Date:", txnDateStr, 40, y, 250, 90);
    drawField(doc, "Bank & Branch Details:", enrollment.bank_branch, 300, y, 255, 130);

    y += 22;
    drawField(doc, "Bank Account Number:", enrollment.account_number, 40, y, 250, 115);
    drawField(doc, "IFSC Code:", enrollment.ifsc_code, 300, y, 255, 130);

    y += 30;
    drawSectionTitle(doc, "3. Nominee Details", y);

    // Parse Nominees list safely
    let nomineesList: any[] = [];
    if (enrollment.nominees) {
      try {
        nomineesList = typeof enrollment.nominees === "string" ? JSON.parse(enrollment.nominees) : enrollment.nominees;
      } catch (e) {
        console.error("Failed to parse nominees JSON:", e);
      }
    }
    if (!Array.isArray(nomineesList)) nomineesList = [];

    y += 22;
    if (nomineesList.length === 0) {
      doc.fillColor("#64748b").fontSize(9).font("Helvetica-Oblique").text("No Nominees registered.", 40, y);
      y += 18;
    } else {
      nomineesList.forEach((n, idx) => {
        if (idx > 0) y += 75;
        doc.fillColor("#14532d").fontSize(9.5).font("Helvetica-Bold").text(`Nominee #${idx + 1}`, 40, y);
        y += 14;
        drawField(doc, "Full Name:", n.name, 40, y, 250, 80);
        drawField(doc, "Relationship:", n.relationship, 300, y, 255, 100);
        y += 22;
        drawField(doc, "Age:", String(n.age || ""), 40, y, 200, 80);
        const propStr = n.proportion ? `${n.proportion}%` : "100%";
        drawField(doc, "Share / Proportion:", propStr, 250, y, 265, 110);
        if (n.address) {
          y += 22;
          drawField(doc, "Address:", n.address, 40, y, 515, 80);
        }
      });
      y += 28;
    }

    y += 10;
    drawSectionTitle(doc, "4. Joint / Co-Applicant Details (If Applicable)", y);
    y += 22;
    drawField(doc, "Joint Applicant Name:", enrollment.joint_applicant_name || "N/A", 40, y, 515, 140);

    drawFooter(doc, 2, totalPages);

    // ─────────────────────────────────────────────────────────────────
    // PAGE 3: Specimen Signature, Declaration, and Office Use
    // ─────────────────────────────────────────────────────────────────
    doc.addPage();
    drawHeader(doc, enrollmentId, formDateStr);

    drawSectionTitle(doc, "5. Specimen Signature Form", 110);

    const firstAppName = enrollment.first_applicant_name || fullName || "First / Sole Applicant";
    const jointAppName = enrollment.joint_applicant_name || "Joint Applicant";

    // Embed specimen signatures side-by-side
    drawSignatureBoxWithBuffer(doc, `Specimen Signature (First / Sole Applicant)\n${firstAppName}`, 40, 138, sigFirstBuf, 240, 70);
    drawSignatureBoxWithBuffer(doc, `Specimen Signature (Joint Applicant)\n${jointAppName}`, 315, 138, sigJointBuf, 240, 70);

    drawSectionTitle(doc, "6. Declaration & Consent", 238);

    y = 265;
    // Checked checkbox with vector checkmark
    drawCheckbox(
      doc,
      "I confirm the Declaration — all information provided by me is true and correct, and I agree to enroll as an investor under the Terms & Conditions of M.M.R. Construction & Developers Private Limited.",
      40,
      y,
      true
    );

    y += 24;
    // Grey declaration box
    doc.lineWidth(1).strokeColor("#cbd5e1").rect(40, y, 515, 48).stroke();
    doc.rect(41, y + 1, 513, 46).fill("#f8fafc");

    doc.fillColor("#1e293b").fontSize(7.5).font("Helvetica-Bold");
    doc.text("Declaration: ", 46, y + 6, { continued: true });
    doc.font("Helvetica").text(
      `I, ${fullName || "—"}, hereby declare that all the information provided in this Investor Enrollment Form is true, correct, and complete to the best of my knowledge. I confirm that I have carefully read, understood and agreed to the Terms and Conditions of M.M.R. Construction & Developers Private Limited.`,
      { width: 503, lineGap: 2 }
    );

    y += 56;
    const signRow = y + 42;

    // Embed investor signature if available
    if (sigFirstBuf && sigFirstBuf.length > 0) {
      try {
        doc.image(sigFirstBuf, 50, signRow - 42, { fit: [180, 38], align: "center", valign: "center" });
      } catch (e) {
        console.warn("[investorPdfService] Error embedding investor signature:", e);
      }
    }

    const declName = fullName !== "—" ? fullName : (enrollment.decl_signature_name || "—");

    doc.lineWidth(1).strokeColor("#1e293b").moveTo(40, signRow).lineTo(240, signRow).stroke();
    doc.moveTo(355, signRow).lineTo(555, signRow).stroke();

    doc.fillColor("#0f172a").fontSize(8.5).font("Helvetica-Bold");
    doc.text("Signature of Investor", 40, signRow + 6, { width: 200, align: "center" });
    doc.text(`Name: ${declName}`, 40, signRow + 18, { width: 200, align: "center" });
    doc.text(`Date: ${declDateStr || formDateStr || "—"} | Place: ${enrollment.decl_place || "—"}`, 40, signRow + 30, { width: 200, align: "center" });

    doc.text("For M.M.R. Construction & Developers Pvt. Ltd.", 355, signRow + 6, { width: 200, align: "center" });
    doc.font("Helvetica").text("Authorized Signatory", 355, signRow + 18, { width: 200, align: "center" });

    // Office Use only
    y = signRow + 50;
    drawSectionTitle(doc, "7. For Office Use Only (Verification Details)", y);
    y += 26;
    drawField(doc, "Application Status:", enrollment.app_status || "Hold/Pending KYC", 40, y, 250, 110);
    drawField(doc, "Verified By:", enrollment.verified_by, 300, y, 255, 110);

    y += 22;
    drawField(doc, "Payment Status:", enrollment.payment_status || "Pending", 40, y, 250, 110);
    const payDateStr = enrollment.payment_status_date ? new Date(enrollment.payment_status_date).toLocaleDateString("en-IN") : "";
    drawField(doc, "Payment Date:", payDateStr, 300, y, 255, 110);

    y += 22;
    drawField(doc, "Authorized Signatory (with Stamp):", enrollment.authorized_signatory, 40, y, 515, 180);

    drawFooter(doc, 3, totalPages);
    doc.end();
  });
}
