import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import sql from "../db.js";
import { getStorageRoot } from "./fileStorage.service.js";
// Helper to draw MMR header on each page
function drawHeader(doc, enrollmentId, formDate) {
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
function drawFooter(doc, pageNum, totalPages) {
    doc.fillColor("#64748b").fontSize(7).font("Helvetica");
    doc.text("Website: https://mmrconstructions.in/ | Email: mmrconstructions@hotmail.com", 40, 770, { align: "left" });
    doc.text(`Page ${pageNum} of ${totalPages}`, 400, 770, { align: "right", width: 155 });
}
// Helper to draw section title bars
function drawSectionTitle(doc, title, y) {
    doc.rect(40, y, 515, 18).fill("#14532d");
    doc.fillColor("#ffffff").fontSize(9).font("Helvetica-Bold").text(title, 48, y + 4);
}
// Helper to draw dotted fields
function drawField(doc, label, value, x, y, width, labelWidth = 120) {
    doc.fillColor("#1e293b").fontSize(8.5).font("Helvetica-Bold").text(label, x, y, { width: labelWidth });
    const valueX = x + labelWidth + 5;
    const valueWidth = width - labelWidth - 5;
    doc.fillColor("#0f172a").font("Helvetica").text(String(value || "—"), valueX, y, { width: valueWidth });
    // Dotted underline
    const lineY = y + 10;
    doc.lineWidth(0.5).strokeColor("#cbd5e1").dash(2, { space: 2 }).moveTo(valueX, lineY).lineTo(x + width, lineY).stroke().undash();
}
// Helper to draw checkboxes
function drawCheckbox(doc, text, x, y, checked = true) {
    doc.lineWidth(1).strokeColor("#14532d").rect(x, y, 10, 10).stroke();
    if (checked) {
        doc.fillColor("#14532d").fontSize(8.5).font("Helvetica-Bold").text("✓", x + 1.5, y + 0.5);
    }
    doc.fillColor("#1e293b").fontSize(8).font("Helvetica").text(text, x + 16, y, { width: 490 });
}
// Helper to draw passport photo slot
function drawPhotoBox(doc, label, x, y, photoPath) {
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
                }
                else {
                    console.warn(`[drawPhotoBox] File does not exist on disk: ${targetFilePath}`);
                }
            }
        }
        catch (e) {
            console.error(`Failed to embed image ${photoPath}:`, e);
        }
    }
    if (!loaded) {
        doc.fillColor("#64748b").fontSize(6.5).font("Helvetica-Bold");
        doc.text(`PHOTO\n(${label})`, x, y + 42, { align: "center", width: boxWidth });
    }
}
// Helper to draw signature box
function drawSignatureBox(doc, label, x, y, sigPath) {
    const boxWidth = 240;
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
        }
        catch (e) {
            console.error(`Failed to embed signature ${sigPath}:`, e);
        }
    }
    doc.fillColor("#64748b").fontSize(7).font("Helvetica-Bold");
    doc.text(label, x, y + boxHeight + 4, { align: "center", width: boxWidth });
}
export async function generateInvestorPdf(id) {
    const [enrollment] = await sql `SELECT * FROM investor_enrollments WHERE id = ${id}`;
    if (!enrollment) {
        throw new Error(`Investor enrollment with ID ${id} not found.`);
    }
    const formDateStr = enrollment.form_date ? new Date(enrollment.form_date).toLocaleDateString("en-IN") : "";
    const dobStr = enrollment.dob ? new Date(enrollment.dob).toLocaleDateString("en-IN") : "";
    const txnDateStr = enrollment.txn_date ? new Date(enrollment.txn_date).toLocaleDateString("en-IN") : "";
    const declDateStr = enrollment.decl_date ? new Date(enrollment.decl_date).toLocaleDateString("en-IN") : "";
    return new Promise((resolve, reject) => {
        const chunks = [];
        const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });
        doc.on("data", (chunk) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", (err) => reject(err));
        const totalPages = 3;
        // ─────────────────────────────────────────────────────────────────
        // PAGE 1: Personal & Address Details
        // ─────────────────────────────────────────────────────────────────
        drawHeader(doc, enrollment.investor_enrollment_id, formDateStr);
        doc.fillColor("#14532d").fontSize(14).font("Helvetica-Bold").text("INVESTOR ENROLLMENT FORM", 40, 110, { align: "center", width: 515 });
        // Photo box top-right
        drawPhotoBox(doc, "investor", 475, 135, enrollment.photo_url);
        drawSectionTitle(doc, "Office metadata", 135);
        let y = 165;
        drawField(doc, "Form No.:", enrollment.form_no, 40, y, 200, 70);
        drawField(doc, "Form Date:", formDateStr, 250, y, 210, 70);
        y += 24;
        drawField(doc, "Branch Code:", enrollment.branch_code, 40, y, 200, 70);
        drawField(doc, "Branch Name:", enrollment.branch_name, 250, y, 210, 70);
        y += 24;
        drawField(doc, "Investor Enrollment ID:", enrollment.investor_enrollment_id, 40, y, 420, 120);
        y += 24;
        drawField(doc, "Project Name:", enrollment.project_name, 40, y, 420, 120);
        y += 28;
        drawSectionTitle(doc, "1. Personal Details", y);
        const fullName = `${enrollment.inv_first_name || ""} ${enrollment.inv_middle_name || ""} ${enrollment.inv_surname || ""}`.trim();
        const fhName = `${enrollment.fh_first_name || ""} ${enrollment.fh_middle_name || ""} ${enrollment.fh_surname || ""}`.trim();
        y += 25;
        drawField(doc, "Full Name (only Adult):", fullName, 40, y, 515, 120);
        y += 24;
        drawField(doc, "Father's / Husband's Name:", fhName, 40, y, 515, 150);
        y += 24;
        drawField(doc, "Date of Birth:", dobStr, 40, y, 250, 90);
        drawField(doc, "Age:", String(enrollment.age || ""), 300, y, 255, 60);
        y += 24;
        drawField(doc, "Gender:", enrollment.gender, 40, y, 250, 90);
        drawField(doc, "Occupation:", enrollment.occupation === 'Other' ? enrollment.occupation_other : enrollment.occupation, 300, y, 255, 100);
        y += 24;
        drawField(doc, "Permanent Address:", enrollment.address, 40, y, 515, 120);
        y += 24;
        drawField(doc, "City / District:", enrollment.city, 40, y, 250, 90);
        drawField(doc, "State:", enrollment.state, 300, y, 255, 60);
        y += 24;
        drawField(doc, "Pin Code:", enrollment.pin_code, 40, y, 250, 90);
        y += 24;
        drawField(doc, "Mobile Number:", enrollment.mobile, 40, y, 250, 90);
        drawField(doc, "Alt Telephone:", enrollment.alt_tel, 300, y, 255, 100);
        y += 24;
        drawField(doc, "Email ID:", enrollment.email, 40, y, 515, 90);
        y += 24;
        drawField(doc, "PAN Card Number:", enrollment.pan, 40, y, 250, 90);
        drawField(doc, "Aadhar Card Number:", enrollment.aadhar, 300, y, 255, 100);
        drawFooter(doc, 1, totalPages);
        // ─────────────────────────────────────────────────────────────────
        // PAGE 2: Payment Details & Nominees
        // ─────────────────────────────────────────────────────────────────
        doc.addPage();
        drawHeader(doc, enrollment.investor_enrollment_id, formDateStr);
        drawSectionTitle(doc, "2. Payment Details", 115);
        y = 145;
        drawField(doc, "Amount Paid (INR):", enrollment.amount ? `₹ ${Number(enrollment.amount).toLocaleString("en-IN")}` : "", 40, y, 515, 120);
        y += 24;
        drawField(doc, "Amount in Words:", enrollment.amount_words, 40, y, 515, 120);
        y += 24;
        drawField(doc, "Payment Mode:", enrollment.payment_mode, 40, y, 250, 90);
        drawField(doc, "Cheque / DD / Txn No.:", enrollment.txn_no, 300, y, 255, 130);
        y += 24;
        drawField(doc, "Transaction Date:", txnDateStr, 40, y, 250, 90);
        drawField(doc, "Bank & Branch Details:", enrollment.bank_branch, 300, y, 255, 130);
        y += 35;
        drawSectionTitle(doc, "3. Nominee Details", y);
        // Nominees list
        let nomineesList = [];
        if (enrollment.nominees) {
            try {
                nomineesList = typeof enrollment.nominees === "string" ? JSON.parse(enrollment.nominees) : enrollment.nominees;
            }
            catch (e) {
                console.error("Failed to parse nominees JSON:", e);
            }
        }
        if (!Array.isArray(nomineesList))
            nomineesList = [];
        y += 25;
        if (nomineesList.length === 0) {
            doc.fillColor("#64748b").fontSize(9).font("Helvetica-Oblique").text("No Nominees registered.", 40, y);
        }
        else {
            nomineesList.forEach((n, idx) => {
                if (idx > 0)
                    y += 95;
                doc.fillColor("#14532d").fontSize(9.5).font("Helvetica-Bold").text(`Nominee #${idx + 1}`, 40, y);
                y += 15;
                drawField(doc, "Full Name:", n.name, 40, y, 250, 80);
                drawField(doc, "Relationship:", n.relationship, 300, y, 255, 100);
                y += 24;
                drawField(doc, "Age:", String(n.age || ""), 40, y, 200, 80);
                drawField(doc, "Aadhar No:", n.aadharNo, 250, y, 265, 100);
                y += 24;
                drawField(doc, "Address:", n.address, 40, y, 515, 80);
            });
        }
        drawFooter(doc, 2, totalPages);
        // ─────────────────────────────────────────────────────────────────
        // PAGE 3: Specimen Signature, Declaration, and Office Use
        // ─────────────────────────────────────────────────────────────────
        doc.addPage();
        drawHeader(doc, enrollment.investor_enrollment_id, formDateStr);
        drawSectionTitle(doc, "4. Specimen Signature Form", 115);
        // Embed specimen signatures side-by-side
        drawSignatureBox(doc, "Specimen Signature (First / Sole Applicant)", 40, 145, enrollment.signature_first_url);
        drawSignatureBox(doc, "Specimen Signature (Joint Applicant)", 315, 145, enrollment.signature_joint_url);
        drawSectionTitle(doc, "5. Declaration & Consent", 240);
        y = 270;
        // Checked checkbox
        drawCheckbox(doc, "I confirm the Declaration — all information provided by me is true and correct, and I agree to enroll as an investor under the Terms & Conditions of M.M.R. Construction & Developers Private Limited.", 40, y, true);
        y += 25;
        // Grey declaration box
        doc.lineWidth(1).strokeColor("#cbd5e1").rect(40, y, 515, 45).stroke();
        doc.rect(41, y + 1, 513, 43).fill("#f8fafc");
        doc.fillColor("#1e293b").fontSize(7.5).font("Helvetica-Bold");
        doc.text("Declaration: ", 46, y + 6, { continued: true });
        doc.font("Helvetica").text(`I, ${fullName || "—"}, hereby declare that all the information provided in this Investor Enrollment Form is true, correct, and complete to the best of my knowledge. I confirm that I have carefully read, understood and agreed to the Terms and Conditions of M.M.R. Construction & Developers Private Limited.`, { width: 503, lineGap: 2 });
        y += 55;
        const signRow = y;
        doc.lineWidth(1).strokeColor("#1e293b").moveTo(40, signRow).lineTo(240, signRow).stroke();
        doc.moveTo(355, signRow).lineTo(555, signRow).stroke();
        doc.fillColor("#0f172a").fontSize(8.5).font("Helvetica-Bold");
        doc.text("Signature of Investor", 40, signRow + 6, { width: 200, align: "center" });
        doc.text(`Name: ${enrollment.decl_signature_name || "—"}`, 40, signRow + 18, { width: 200, align: "center" });
        doc.text(`Date: ${declDateStr || "—"} | Place: ${enrollment.decl_place || "—"}`, 40, signRow + 30, { width: 200, align: "center" });
        doc.text("For M.M.R. Construction & Developers Pvt. Ltd.", 355, signRow + 6, { width: 200, align: "center" });
        doc.font("Helvetica").text("Authorized Signatory", 355, signRow + 18, { width: 200, align: "center" });
        // Office Use only
        y += 65;
        drawSectionTitle(doc, "6. For Office Use Only (Verification Details)", y);
        y += 28;
        drawField(doc, "Application Status:", enrollment.app_status || "Hold/Pending KYC", 40, y, 250, 110);
        drawField(doc, "Verified By:", enrollment.verified_by, 300, y, 255, 110);
        y += 24;
        drawField(doc, "Payment Status:", enrollment.payment_status || "Pending", 40, y, 250, 110);
        const payDateStr = enrollment.payment_status_date ? new Date(enrollment.payment_status_date).toLocaleDateString("en-IN") : "";
        drawField(doc, "Payment Date:", payDateStr, 300, y, 255, 110);
        y += 24;
        drawField(doc, "Authorized Signatory (with Stamp):", enrollment.authorized_signatory, 40, y, 515, 180);
        drawFooter(doc, 3, totalPages);
        doc.end();
    });
}
