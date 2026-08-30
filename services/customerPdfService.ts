import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import sql from "../db.js";
import { getStorageRoot } from "./fileStorage.service.js";

// Helper to draw MMR header on each page
function drawHeader(doc: any, applicationNo: string, formDate: string) {
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
  doc.text(`Application No: ${applicationNo || "—"}`, 380, 53, { align: "right", width: 170 });
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
function drawField(doc: any, label: string, value: string, x: number, y: number, width: number, labelWidth = 120) {
  doc.fillColor("#1e293b").fontSize(8.5).font("Helvetica-Bold").text(label, x, y, { width: labelWidth });
  
  const valueX = x + labelWidth + 5;
  const valueWidth = width - labelWidth - 5;
  
  doc.fillColor("#0f172a").font("Helvetica").text(String(value || "—"), valueX, y, { width: valueWidth });
  
  // Dotted underline
  const lineY = y + 10;
  doc.lineWidth(0.5).strokeColor("#cbd5e1").dash(2, { space: 2 }).moveTo(valueX, lineY).lineTo(x + width, lineY).stroke().undash();
}

// Helper to draw checkboxes
function drawCheckbox(doc: any, text: string, x: number, y: number, checked = true) {
  doc.lineWidth(1).strokeColor("#14532d").rect(x, y, 10, 10).stroke();
  if (checked) {
    doc.fillColor("#14532d").fontSize(8.5).font("Helvetica-Bold").text("✓", x + 1.5, y + 0.5);
  }
  doc.fillColor("#1e293b").fontSize(8).font("Helvetica").text(text, x + 16, y, { width: 490 });
}

// Helper to draw passport photo slot
function drawPhotoBox(doc: any, label: string, x: number, y: number, photoPath: string | null) {
  const boxWidth = 80;
  const boxHeight = 100;
  
  // Draw border
  doc.lineWidth(1).strokeColor("#64748b").rect(x, y, boxWidth, boxHeight).stroke();
  
  let loaded = false;
  if (photoPath) {
    try {
      const rootDir = getStorageRoot();
      const match = photoPath.match(/\/uploads\/(.+)$/);
      if (match) {
        const relPath = match[1];
        const targetFilePath = path.resolve(rootDir, relPath);
        
        if (fs.existsSync(targetFilePath)) {
          doc.image(targetFilePath, x + 2, y + 2, { width: boxWidth - 4, height: boxHeight - 4 });
          loaded = true;
        } else {
          console.warn(`[drawPhotoBox] File does not exist on disk: ${targetFilePath}`);
        }
      }
    } catch (e) {
      console.error(`Failed to embed image ${photoPath}:`, e);
    }
  }
  
  if (!loaded) {
    doc.fillColor("#64748b").fontSize(6.5).font("Helvetica-Bold");
    doc.text(`PHOTO\n(${label})`, x, y + 42, { align: "center", width: boxWidth });
  }
}

// Helper to draw signature box
function drawSignatureBox(doc: any, label: string, x: number, y: number, sigPath: string | null, boxWidth = 160) {
  const boxHeight = 65;
  
  // Draw border
  doc.lineWidth(1).strokeColor("#64748b").rect(x, y, boxWidth, boxHeight).stroke();
  
  let loaded = false;
  if (sigPath) {
    try {
      const rootDir = getStorageRoot();
      const match = sigPath.match(/\/uploads\/(.+)$/);
      if (match) {
        const relPath = match[1];
        const targetFilePath = path.resolve(rootDir, relPath);
        
        if (fs.existsSync(targetFilePath)) {
          doc.image(targetFilePath, x + 5, y + 5, { width: boxWidth - 10, height: boxHeight - 10 });
          loaded = true;
        }
      }
    } catch (e) {
      console.error(`Failed to embed signature ${sigPath}:`, e);
    }
  }
  
  doc.fillColor("#64748b").fontSize(7).font("Helvetica-Bold");
  doc.text(label, x, y + boxHeight + 4, { align: "center", width: boxWidth });
}

export async function generateCustomerPdf(id: string): Promise<Buffer> {
  const [submission] = await sql`SELECT * FROM customer_enrollment_submissions WHERE id = ${id}`;
  if (!submission) {
    throw new Error(`Customer submission with ID ${id} not found.`);
  }

  // Fetch nominees
  const nomineesList = await sql`SELECT * FROM customer_nominees WHERE submission_id = ${id}`;

  const formDateStr = submission.form_date ? new Date(submission.form_date).toLocaleDateString("en-IN") : "";
  const dobStr = submission.date_of_birth ? new Date(submission.date_of_birth).toLocaleDateString("en-IN") : "";
  const coDobStr = submission.co_date_of_birth ? new Date(submission.co_date_of_birth).toLocaleDateString("en-IN") : "";
  const txnDateStr = submission.txn_date ? new Date(submission.txn_date).toLocaleDateString("en-IN") : "";

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err) => reject(err));

    const totalPages = 4;

    // ─────────────────────────────────────────────────────────────────
    // PAGE 1: Property Specs & Sole Applicant Details
    // ─────────────────────────────────────────────────────────────────
    drawHeader(doc, submission.application_no, formDateStr);
    
    doc.fillColor("#14532d").fontSize(14).font("Helvetica-Bold").text("CUSTOMER ENROLLMENT FORM", 40, 110, { align: "center", width: 515 });
    
    // Photo box top-right
    drawPhotoBox(doc, "applicant", 475, 135, submission.photo_first_applicant_url);

    drawSectionTitle(doc, "Property Booking Specifications", 135);
    let y = 165;
    drawField(doc, "Project Name:", submission.project_name, 40, y, 200, 80);
    drawField(doc, "Property Type:", submission.property_type === 'Other' ? submission.property_type_other : submission.property_type, 250, y, 210, 90);

    y += 24;
    drawField(doc, "Plot / Flat No.:", submission.plot_flat_no, 40, y, 200, 80);
    drawField(doc, "Block / Tower:", submission.block_tower, 250, y, 210, 90);

    y += 24;
    drawField(doc, "Super / Carpet Area:", submission.size_area, 40, y, 200, 100);
    drawField(doc, "Rate per Unit (INR):", submission.rate_per_unit ? `₹ ${Number(submission.rate_per_unit).toLocaleString("en-IN")}` : "", 250, y, 210, 100);

    y += 24;
    drawField(doc, "Basic Sale Price (BSP):", submission.basic_sale_price ? `₹ ${Number(submission.basic_sale_price).toLocaleString("en-IN")}` : "", 40, y, 200, 110);
    drawField(doc, "PLC / Dev. Charges:", submission.plc_dev_charges ? `₹ ${Number(submission.plc_dev_charges).toLocaleString("en-IN")}` : "", 250, y, 210, 110);

    y += 24;
    drawField(doc, "Total Property Cost:", submission.total_property_value ? `₹ ${Number(submission.total_property_value).toLocaleString("en-IN")}` : "", 40, y, 420, 110);

    y += 28;
    drawSectionTitle(doc, "1. Sole / First Applicant Details", y);
    
    y += 25;
    drawField(doc, "Full Name (only Adult):", submission.applicant_name, 40, y, 515, 120);
    
    y += 24;
    drawField(doc, "Father's / Husband's Name:", submission.fh_name, 40, y, 515, 150);

    y += 24;
    drawField(doc, "Date of Birth:", dobStr, 40, y, 250, 90);
    drawField(doc, "Age:", String(submission.age || ""), 300, y, 255, 60);

    y += 24;
    drawField(doc, "Gender:", submission.gender, 40, y, 250, 90);
    drawField(doc, "Marital Status:", submission.marital_status, 300, y, 255, 100);

    y += 24;
    drawField(doc, "Occupation:", submission.occupation, 40, y, 250, 90);
    drawField(doc, "Nationality:", submission.nationality === 'Other' ? submission.nationality_other : submission.nationality, 300, y, 255, 100);

    y += 24;
    drawField(doc, "PAN Card Number:", submission.pan_no, 40, y, 250, 90);
    drawField(doc, "Aadhar Card Number:", submission.aadhar_no, 300, y, 255, 100);

    drawFooter(doc, 1, totalPages);

    // ─────────────────────────────────────────────────────────────────
    // PAGE 2: Co-Applicant Details & Contact Info
    // ─────────────────────────────────────────────────────────────────
    doc.addPage();
    drawHeader(doc, submission.application_no, formDateStr);

    // Co-applicant photo box
    drawPhotoBox(doc, "co-applicant", 475, 115, submission.photo_co_applicant_url);

    drawSectionTitle(doc, "2. Co-Applicant Details (If Any)", 115);
    y = 145;
    drawField(doc, "Co-Applicant Name:", submission.co_applicant_name, 40, y, 420, 110);
    
    y += 24;
    drawField(doc, "Father's / Husband's Name:", submission.co_fh_name, 40, y, 420, 150);

    y += 24;
    drawField(doc, "Relation to First Applicant:", submission.co_relation, 40, y, 250, 130);
    drawField(doc, "Date of Birth:", coDobStr, 300, y, 255, 80);

    y += 24;
    drawField(doc, "Age:", String(submission.co_age || ""), 40, y, 150, 60);
    drawField(doc, "Gender:", submission.co_gender, 200, y, 160, 60);
    drawField(doc, "Mobile Number:", submission.co_mobile, 370, y, 185, 80);

    y += 24;
    drawField(doc, "PAN No:", submission.co_pan_no, 40, y, 250, 60);
    drawField(doc, "Aadhar No:", submission.co_aadhar_no, 300, y, 255, 80);

    y += 24;
    drawField(doc, "Present Address:", submission.co_present_address, 40, y, 515, 110);
    drawField(doc, "Co-Applicant Email:", submission.co_email, 40, y + 24, 515, 110);

    y += 60;
    drawSectionTitle(doc, "Contact Details (First Applicant)", y);
    y += 25;
    drawField(doc, "Present Address:", submission.present_address, 40, y, 515, 110);
    
    y += 24;
    drawField(doc, "City / District:", submission.present_city, 40, y, 250, 90);
    drawField(doc, "State & Pin Code:", submission.present_state_pin, 300, y, 255, 100);

    y += 24;
    drawField(doc, "Permanent Address:", submission.permanent_address, 40, y, 515, 110);

    y += 24;
    drawField(doc, "City / District:", submission.permanent_city, 40, y, 250, 90);
    drawField(doc, "State & Pin Code:", submission.permanent_state_pin, 300, y, 255, 100);

    y += 24;
    drawField(doc, "Mobile No. 1:", submission.mobile_1, 40, y, 250, 90);
    drawField(doc, "Mobile No. 2:", submission.mobile_2, 300, y, 255, 100);

    y += 24;
    drawField(doc, "Email Address:", submission.email_1, 40, y, 515, 90);

    drawFooter(doc, 2, totalPages);

    // ─────────────────────────────────────────────────────────────────
    // PAGE 3: Nominees, Payment, Bank & Introducer
    // ─────────────────────────────────────────────────────────────────
    doc.addPage();
    drawHeader(doc, submission.application_no, formDateStr);

    drawSectionTitle(doc, "3. Nominee Details", 115);
    y = 145;
    if (nomineesList.length === 0) {
      doc.fillColor("#64748b").fontSize(9).font("Helvetica-Oblique").text("No Nominees registered.", 40, y);
    } else {
      nomineesList.forEach((n: any, idx: number) => {
        if (idx > 0) y += 50;
        doc.fillColor("#14532d").fontSize(9.5).font("Helvetica-Bold").text(`Nominee #${idx + 1}`, 40, y);
        y += 15;
        drawField(doc, "Name:", n.nominee_name, 40, y, 160, 45);
        drawField(doc, "Relation:", n.relation, 210, y, 170, 50);
        drawField(doc, "Age/DOB:", n.age_dob, 390, y, 165, 55);
        
        y += 18;
        drawField(doc, "Aadhar Number:", n.aadhar_no, 40, y, 250, 85);
      });
    }

    y = 285;
    drawSectionTitle(doc, "4. Booking Payment Details", y);
    y += 25;
    drawField(doc, "Booking Amount Paid:", submission.booking_amount ? `₹ ${Number(submission.booking_amount).toLocaleString("en-IN")}` : "", 40, y, 515, 120);
    y += 24;
    drawField(doc, "Amount in Words:", submission.booking_amount_words, 40, y, 515, 120);
    y += 24;
    drawField(doc, "Payment Mode:", submission.payment_mode, 40, y, 250, 90);
    drawField(doc, "Cheque / DD / Txn No.:", submission.txn_cheque_no, 300, y, 255, 120);
    y += 24;
    drawField(doc, "Transaction Date:", txnDateStr, 40, y, 250, 90);
    drawField(doc, "Drawn Bank & Branch:", submission.drawn_bank_branch, 300, y, 255, 120);

    y += 35;
    drawSectionTitle(doc, "5. Bank Account Details (For Refund/Reference)", y);
    y += 25;
    drawField(doc, "Account Holder Name:", submission.acc_holder_name, 40, y, 250, 110);
    drawField(doc, "Bank & Branch Name:", submission.acc_bank_branch, 300, y, 255, 110);
    y += 24;
    drawField(doc, "Account Number:", submission.acc_number, 40, y, 250, 110);
    drawField(doc, "IFSC Code:", submission.ifsc_code, 300, y, 255, 110);

    y += 35;
    drawSectionTitle(doc, "6. Introducer / Associate Details", y);
    y += 25;
    drawField(doc, "Associate Name:", submission.associate_name, 40, y, 250, 110);
    drawField(doc, "Associate ID:", submission.associate_id, 300, y, 255, 110);
    y += 24;
    drawField(doc, "Associate Mobile:", submission.associate_mobile, 40, y, 250, 110);
    drawField(doc, "Associate Sign. Name:", submission.associate_signature_name, 300, y, 255, 110);

    drawFooter(doc, 3, totalPages);

    // ─────────────────────────────────────────────────────────────────
    // PAGE 4: Specimen Signatures, Declaration, and Office Use
    // ─────────────────────────────────────────────────────────────────
    doc.addPage();
    drawHeader(doc, submission.application_no, formDateStr);

    drawSectionTitle(doc, "Specimen Signature Panel", 115);
    
    // Embed specimen signatures side-by-side
    drawSignatureBox(doc, "Signature of Sole / First Applicant", 40, 145, submission.signature_sole_first_applicant_url, 160);
    drawSignatureBox(doc, "Signature of Co-Applicant", 215, 145, submission.signature_co_applicant_url, 160);
    drawSignatureBox(doc, "Authorized Signatory (MMR)", 395, 145, submission.signature_authorized_signatory_url, 160);

    drawSectionTitle(doc, "7. Declaration & Consent", 240);

    y = 270;
    drawCheckbox(doc, "I confirm the Declaration — all info provided is true and correct, and I agree to the terms and conditions of M.M.R. Construction & Developers Pvt. Ltd.", 40, y, true);

    y += 25;
    doc.lineWidth(1).strokeColor("#cbd5e1").rect(40, y, 515, 45).stroke();
    doc.rect(41, y + 1, 513, 43).fill("#f8fafc");
    
    doc.fillColor("#1e293b").fontSize(7.5).font("Helvetica-Bold");
    doc.text("Declaration: ", 46, y + 6, { continued: true });
    doc.font("Helvetica").text(`I/We hereby declare that all the particulars and information given by me/us in this application form are true and correct to the best of my/our knowledge. I/We have carefully read, understood and agreed to abide by all the Terms & Conditions of the company mentioned above, and further changes made from time to time.`, { width: 503, lineGap: 2 });

    y += 55;
    const signRow = y;
    doc.lineWidth(1).strokeColor("#1e293b").moveTo(40, signRow).lineTo(240, signRow).stroke();
    doc.moveTo(355, signRow).lineTo(555, signRow).stroke();
    
    doc.fillColor("#0f172a").fontSize(8.5).font("Helvetica-Bold");
    doc.text("Signature of Applicant", 40, signRow + 6, { width: 200, align: "center" });
    doc.text(`Name: ${submission.applicant_name || "—"}`, 40, signRow + 18, { width: 200, align: "center" });
    doc.text(`Date: ${formDateStr || "—"}`, 40, signRow + 30, { width: 200, align: "center" });

    doc.text("For M.M.R. Construction & Developers Pvt. Ltd.", 355, signRow + 6, { width: 200, align: "center" });
    doc.font("Helvetica").text("Authorized Signatory (Stamp & Sign)", 355, signRow + 18, { width: 200, align: "center" });

    // Office Use only
    y += 65;
    drawSectionTitle(doc, "8. For Office Use Only (Verification Details)", y);
    y += 28;
    drawField(doc, "Application Status:", submission.application_status || "Pending", 40, y, 250, 110);
    drawField(doc, "Verified By:", submission.verified_by, 300, y, 255, 110);

    y += 24;
    drawField(doc, "Payment Status:", submission.payment_status || "Pending", 40, y, 250, 110);
    const payDateStr = submission.payment_status_date ? new Date(submission.payment_status_date).toLocaleDateString("en-IN") : "";
    drawField(doc, "Payment Date:", payDateStr, 300, y, 255, 110);

    drawFooter(doc, 4, totalPages);

    doc.end();
  });
}
