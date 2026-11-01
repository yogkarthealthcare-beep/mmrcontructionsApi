import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import sql from "../db.js";
import { getStorageRoot } from "./fileStorage.service.js";
import { resolveImageBuffer, drawPhotoBoxWithBuffer, drawSignatureBoxWithBuffer } from "./pdfImageHelper.js";

// Helper to draw MMR header on each page
function drawHeader(doc: any, associateId: any, signDate: any) {
    const brandColor = "#14532d";
    // Green header rectangle
    doc.rect(40, 20, 515, 58).fill(brandColor);
    // Logo: White circle with green "MMR" text
    doc.fillColor("#ffffff").circle(75, 49, 19).fill();
    doc.fillColor(brandColor).fontSize(10).font("Helvetica-Bold").text("MMR", 63, 45);
    // Company Name
    doc.fillColor("#ffffff").fontSize(12.5).font("Helvetica-Bold").text("M.M.R. CONSTRUCTION & DEVELOPERS PRIVATE", 110, 29);
    doc.text("LIMITED", 110, 42);
    // Subtext
    doc.fontSize(6.5).font("Helvetica").text("Head Office: 00, Tribhuvan Khera, Sheshpur Nari", 110, 55);
    doc.text("Corporate Office: Unnao, Uttar Pradesh, India 209801", 110, 64);
    // Metadata Box on Right
    doc.fillColor("#ffffff").fontSize(6.5).font("Helvetica");
    doc.text("Ph No. 9511119879 | 8429823067", 380, 25, { align: "right", width: 170 });
    doc.text("GST No. 09AATCM6753A1Z5", 380, 34, { align: "right", width: 170 });
    doc.text("CIN No. U68200UP2025PTC229203", 380, 43, { align: "right", width: 170 });
    doc.text(`Associate ID: ${associateId || "—"}`, 380, 52, { align: "right", width: 170 });
    doc.text(`Submitted: ${signDate || "—"}`, 380, 61, { align: "right", width: 170 });
    // Watermark banner
    doc.rect(40, 78, 515, 11).fill("#b3261e");
    doc.fillColor("#ffffff").fontSize(6.5).font("Helvetica-Bold").text("OFFICIAL ENROLLMENT PRINTOUT", 40, 80.5, { align: "center", width: 515 });
}

// Helper to draw MMR footer on each page
function drawFooter(doc: any, pageNum: number, totalPages: number) {
    doc.fillColor("#64748b").fontSize(7).font("Helvetica");
    doc.text("Website: https://mmrconstructions.in/ | Email: mmrconstructions@hotmail.com", 40, 770, { align: "left" });
    doc.text(`Page ${pageNum} of ${totalPages}`, 400, 770, { align: "right", width: 155 });
}

// Helper to draw section title bars
function drawSectionTitle(doc: any, title: string, y: number, height = 16) {
    doc.rect(40, y, 515, height).fill("#14532d");
    doc.fillColor("#ffffff").fontSize(8.5).font("Helvetica-Bold").text(title, 48, y + 3.5);
}

// Helper to draw dotted fields with crisp typography
function drawField(doc: any, label: string, value: any, x: number, y: number, width: number, labelWidth = 105) {
    doc.fillColor("#1e293b").fontSize(8).font("Helvetica-Bold").text(label, x, y, { width: labelWidth, ellipsis: true });
    const valueX = x + labelWidth + 3;
    const valueWidth = width - labelWidth - 3;
    doc.fillColor("#0f172a").fontSize(8).font("Helvetica").text(String(value || "—"), valueX, y, { width: valueWidth, ellipsis: true });
    // Dotted underline
    const lineY = y + 9.5;
    doc.lineWidth(0.5).strokeColor("#cbd5e1").dash(2, { space: 2 }).moveTo(valueX, lineY).lineTo(x + width, lineY).stroke().undash();
}

// Helper to draw checkboxes
function drawCheckbox(doc: any, text: string, x: number, y: number, checked = true) {
    doc.lineWidth(0.8).strokeColor("#14532d").rect(x, y, 9, 9).stroke();
    if (checked) {
        doc.fillColor("#14532d").fontSize(7.5).font("Helvetica-Bold").text("✓", x + 1, y + 0.5);
    }
    doc.fillColor("#1e293b").fontSize(7.5).font("Helvetica").text(text, x + 14, y - 0.5, { width: 500, lineGap: 1 });
}

export async function generateAssociatePdf(associateId: string | number): Promise<Buffer> {
    // 1. Fetch data from DB
    const [associate] = await sql`SELECT * FROM associate_enrollment WHERE id = ${associateId}`;
    if (!associate) {
        throw new Error(`Associate with ID ${associateId} not found.`);
    }
    const addresses = await sql`SELECT * FROM associate_address WHERE associate_id = ${associateId}`;
    const [bank] = await sql`SELECT * FROM associate_bank_details WHERE associate_id = ${associateId}`;
    const [nominee] = await sql`SELECT * FROM associate_nominee WHERE associate_id = ${associateId}`;
    const [sponsor] = await sql`SELECT * FROM associate_sponsor WHERE associate_id = ${associateId}`;

    const permAddr = addresses.find((a: any) => a.address_type === "permanent") || {};
    const localAddr = addresses.find((a: any) => a.address_type === "local") || {};

    const signDateStr = associate.sign_date ? new Date(associate.sign_date).toLocaleDateString("en-IN") : "";
    const dobStr = associate.dob ? new Date(associate.dob).toLocaleDateString("en-IN") : "";
    const nomineeDobStr = nominee?.dob ? new Date(nominee.dob).toLocaleDateString("en-IN") : "";

    // Pre-fetch applicant/nominee photos and signature buffers asynchronously
    const [applicantPhotoBuf, nomineePhotoBuf, applicantSignBuf, sponsorSignBuf] = await Promise.all([
        resolveImageBuffer(associate.applicant_photo_path),
        resolveImageBuffer(nominee?.photo_path),
        resolveImageBuffer(associate.signature_path),
        resolveImageBuffer(sponsor?.signature_path)
    ]);

    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });
        doc.on("data", (chunk: Buffer) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", (err: any) => reject(err));

        const totalPages = 3;

        // ═════════════════════════════════════════════════════════════════
        // PAGE 1: Personal Details + Address Details + Bank Details
        // ═════════════════════════════════════════════════════════════════
        drawHeader(doc, associateId, signDateStr);
        doc.fillColor("#14532d").fontSize(13).font("Helvetica-Bold").text("ASSOCIATE ENROLLMENT FORM", 40, 97, { align: "center", width: 515 });

        // 1. Personal Details
        const p1SecY = 116;
        drawSectionTitle(doc, "1. Personal Details", p1SecY, 15);

        // Photo box placed strictly BELOW the green banner with 6pt clear gap
        const photoY = p1SecY + 20; // 136
        const photoWidth = 75;
        const photoHeight = 90;
        drawPhotoBoxWithBuffer(doc, "Applicant", 480, photoY, applicantPhotoBuf, photoWidth, photoHeight);

        // Beside photo fields (x: 40 to 470, width: 430)
        let y = photoY;
        drawField(doc, "Full Name (only Adult):", associate.full_name, 40, y, 430, 105);
        y += 18;
        drawField(doc, "Date of Birth:", dobStr, 40, y, 205, 65);
        drawField(doc, "Gender:", associate.gender, 255, y, 215, 45);
        y += 18;
        drawField(doc, "Father's Name:", associate.father_name, 40, y, 430, 75);
        y += 18;
        drawField(doc, "Mother's Name:", associate.mother_name, 40, y, 430, 75);
        y += 18;
        drawField(doc, "Spouse's Name:", associate.spouse_name, 40, y, 430, 75);

        // Below photo fields (y = 232 onwards, full width 515 pt: x = 40 to 555)
        y = photoY + photoHeight + 6; // 232
        drawField(doc, "Contact No. (i):", associate.contact_no_1, 40, y, 250, 75);
        drawField(doc, "(ii):", associate.contact_no_2, 300, y, 255, 25);
        y += 18;
        drawField(doc, "Nationality:", associate.nationality, 40, y, 250, 75);
        drawField(doc, "Residential Status:", associate.residential_status, 300, y, 255, 95);
        y += 18;
        drawField(doc, "Pan No.:", associate.pan_no, 40, y, 250, 75);
        drawField(doc, "Aadhar No.:", associate.aadhar_no, 300, y, 255, 95);
        y += 18;
        drawField(doc, "E-mail Id:", associate.email, 40, y, 515, 75);
        y += 18;
        drawField(doc, "Occupation:", associate.occupation, 40, y, 250, 75);
        drawField(doc, "Annual Income:", associate.annual_income, 300, y, 255, 95);
        y += 18;
        drawField(doc, "Education:", associate.education, 40, y, 165, 55);
        drawField(doc, "Category:", associate.category, 215, y, 160, 50);
        drawField(doc, "Religion:", associate.religion, 385, y, 170, 50);

        // 2. Address Details
        y += 24;
        drawSectionTitle(doc, "2. Address Details", y, 15);
        y += 19;
        doc.fillColor("#14532d").fontSize(8).font("Helvetica-Bold").text("Permanent Address", 40, y);
        y += 13;
        drawField(doc, "Local Address:", permAddr.local_address, 40, y, 515, 75);
        y += 17;
        drawField(doc, "City/District:", permAddr.city, 40, y, 165, 60);
        drawField(doc, "State:", permAddr.state, 215, y, 160, 35);
        drawField(doc, "Pin Code:", permAddr.pin_code, 385, y, 170, 50);

        y += 20;
        doc.fillColor("#14532d").fontSize(8).font("Helvetica-Bold").text("Local / Present Address", 40, y);
        y += 13;
        drawField(doc, "Local Address:", localAddr.local_address, 40, y, 515, 75);
        y += 17;
        drawField(doc, "City/District:", localAddr.city, 40, y, 165, 60);
        drawField(doc, "State:", localAddr.state, 215, y, 160, 35);
        drawField(doc, "Pin Code:", localAddr.pin_code, 385, y, 170, 50);

        // 3. Bank Details
        y += 24;
        drawSectionTitle(doc, "3. Bank Details", y, 15);
        y += 19;
        drawField(doc, "Bank Name:", bank?.bank_name, 40, y, 250, 75);
        drawField(doc, "Account Holder:", bank?.account_holder_name, 300, y, 255, 95);
        y += 18;
        drawField(doc, "Account No.:", bank?.account_no, 40, y, 250, 75);
        drawField(doc, "IFSC Code:", bank?.ifsc_code, 300, y, 255, 95);
        y += 18;
        drawField(doc, "Branch Name:", bank?.branch_name, 40, y, 250, 75);
        drawField(doc, "Branch Code:", bank?.branch_code, 300, y, 255, 95);
        y += 18;
        drawField(doc, "MICR Code:", bank?.micr_code, 40, y, 250, 75);
        drawField(doc, "Swift Code:", bank?.swift_code, 300, y, 255, 95);
        y += 18;
        drawField(doc, "Branch Country:", bank?.branch_country, 40, y, 515, 75);

        drawFooter(doc, 1, totalPages);

        // ═════════════════════════════════════════════════════════════════
        // PAGE 2: Nominee Details + Sponsor Details + Terms & Commission + Rewards Table
        // ═════════════════════════════════════════════════════════════════
        doc.addPage();
        drawHeader(doc, associateId, signDateStr);

        // 4. Nominee Details
        const p2SecY = 97;
        drawSectionTitle(doc, "4. Nominee Details", p2SecY, 15);

        // Nominee photo box strictly BELOW green banner
        const nomPhotoY = p2SecY + 20; // 117
        drawPhotoBoxWithBuffer(doc, "Nominee", 480, nomPhotoY, nomineePhotoBuf, 75, 80);

        // Beside nominee photo (x: 40 to 470)
        y = nomPhotoY;
        drawField(doc, "Nominee Name:", nominee?.nominee_name, 40, y, 430, 85);
        y += 18;
        drawField(doc, "Date of Birth:", nomineeDobStr, 40, y, 205, 65);
        drawField(doc, "Gender:", nominee?.gender, 255, y, 215, 45);
        y += 18;
        drawField(doc, "Relationship:", nominee?.relationship, 40, y, 205, 65);
        drawField(doc, "Nationality:", nominee?.nationality, 255, y, 215, 60);
        y += 18;
        drawField(doc, "PAN No.:", nominee?.pan_no, 40, y, 205, 65);
        drawField(doc, "Aadhar No.:", nominee?.aadhar_no, 255, y, 215, 60);

        // Below nominee photo
        y = nomPhotoY + 80 + 6; // 203
        drawField(doc, "Residential Status:", nominee?.residential_status, 40, y, 515, 85);
        y += 18;
        drawField(doc, "Nominee Address:", nominee?.address, 40, y, 515, 85);

        // 5. Sponsor Details
        y += 24;
        drawSectionTitle(doc, "5. Sponsor / Introducer Details", y, 15);
        y += 19;
        drawField(doc, "Sponsor's/Introducer's Name:", sponsor?.sponsor_name, 40, y, 515, 130);
        y += 18;
        drawField(doc, "Code No.:", sponsor?.sponsor_code, 40, y, 250, 75);
        drawField(doc, "Contact No.:", sponsor?.sponsor_contact, 300, y, 255, 75);
        y += 18;
        // Sponsor Signature box inline
        drawSignatureBoxWithBuffer(doc, "Sponsor Signature", 40, y, sponsorSignBuf, 180, 36);

        // 6. Terms & Conditions & Commission Rules
        y += 44;
        drawSectionTitle(doc, "6. Terms & Conditions & Commission Rules", y, 15);
        y += 19;

        const tcList = [
            ["1. Registration & KYC: ", "Associate registration is free and linked to Aadhar & PAN. Full KYC verification is mandatory."],
            ["2. Independent Contractor: ", "Acts as an independent channel partner; not a salaried employee. No standard employee benefits apply."],
            ["3. Direct Commission: ", "Associate earns 5% commission on direct plot sales based on company prescribed rates."],
            ["4. Member Sales Rule: ", "When a Team Member sells, they get 5% direct commission and their Associate (Leader) gets 0.5% override."],
            ["5. Associate Sales Rule: ", "When the Associate sells directly, they receive full 5% commission on the sale value."],
            ["6. Target & Bonanza Rewards: ", "Evaluated over a 6-month timeframe. Set sales targets unlock prizes from gadgets to cars."],
            ["7. Patrolling Allowance: ", "Achieving 2,000 sq. yards cumulative sales unlocks ₹12,000/month patrolling allowance for 72 months (6 yrs)."]
        ];

        doc.fontSize(7.5);
        tcList.forEach(([title, text]) => {
            doc.fillColor("#14532d").font("Helvetica-Bold").text(title, 40, y, { continued: true });
            doc.fillColor("#1e293b").font("Helvetica").text(text, { width: 515, lineGap: 1 });
            y = doc.y + 4;
        });

        // Sales Target & Bonanza Rewards Table
        y += 4;
        const tableTop = y;
        const colWidths = [28, 85, 75, 327];
        const headers = ["Sr.", "Sales Target", "Offer Value", "Suggested Reward Items"];

        // Header row
        doc.rect(40, tableTop, 515, 15).fill("#14532d");
        doc.fillColor("#ffffff").fontSize(7).font("Helvetica-Bold");
        let currentX = 40;
        headers.forEach((h, idx) => {
            doc.text(h, currentX + 4, tableTop + 4, { width: colWidths[idx] - 8, align: idx === 3 ? "left" : "center" });
            currentX += colWidths[idx];
        });

        const rows = [
            ["1", "50 sq. Gaj", "5 points", "Branded Smartwatch / Mixer Grinder / Trolley Bag"],
            ["2", "100 sq. Gaj", "10 points", "Android Smartphone / Normal LED TV"],
            ["3", "200 sq. Gaj", "20 points", "Smart LED TV / Washing Machine / Refrigerator"],
            ["4", "500 sq. Gaj", "100 points", "Honda Activa / Hero Splendor Plus / Apple iPhone"],
            ["5", "1000 sq. Gaj", "300 points", "Royal Enfield Bullet / Gold Coin"],
            ["6", "1500 sq. Gaj", "650 points", "Tata Tiago / Maruti Celerio / Renault Kwid"],
            ["7", "2000 sq. Gaj", "1000 points", "Tata Punch / Maruti Brezza / Maruti Fronx"]
        ];

        let rowY = tableTop + 15;
        doc.fontSize(6.8).font("Helvetica");
        rows.forEach((row, rowIdx) => {
            if (rowIdx % 2 === 1) {
                doc.rect(40, rowY, 515, 13).fill("#f8fafc");
            }
            doc.fillColor("#0f172a");
            let rx = 40;
            row.forEach((cell, colIdx) => {
                doc.text(cell, rx + 4, rowY + 3, { width: colWidths[colIdx] - 8, align: colIdx === 3 ? "left" : "center" });
                rx += colWidths[colIdx];
            });
            doc.lineWidth(0.4).strokeColor("#cbd5e1").moveTo(40, rowY + 13).lineTo(555, rowY + 13).stroke();
            rowY += 13;
        });

        // Table borders
        doc.lineWidth(0.5).strokeColor("#94a3b8");
        doc.rect(40, tableTop, 515, rowY - tableTop).stroke();
        let vx = 40;
        for (let i = 0; i < colWidths.length - 1; i++) {
            vx += colWidths[i];
            doc.moveTo(vx, tableTop).lineTo(vx, rowY).stroke();
        }

        drawFooter(doc, 2, totalPages);

        // ═════════════════════════════════════════════════════════════════
        // PAGE 3: Benefits & Policies + 6 Checkboxes + Declaration + Signatures
        // ═════════════════════════════════════════════════════════════════
        doc.addPage();
        drawHeader(doc, associateId, signDateStr);

        // 7. Benefits, Code of Conduct & Policies
        drawSectionTitle(doc, "7. Benefits, Code of Conduct & Policies", 97, 15);
        y = 117;

        const policies = [
            ["8. Accidental Death Benefit: ", "In case of accidental death during active tenure, company offers nominee ₹3,00,000 aid or a 50 sq. yd plot."],
            ["9. Accidental Disability Benefit: ", "Financial assistance of ₹25,000 to ₹1,00,000 provided based on verified permanent physical injury."],
            ["10. Financial Liability: ", "No individual cash collections permitted. All funds must be directly deposited into company accounts."],
            ["11. Marketing & Confidentiality: ", "Use official marketing tools only. Client leads, sales materials and company data must be held confidential."],
            ["12. Termination for Misconduct: ", "Fraud, false commitments, or forgery leads to instant ID cancellation and forfeiture of all incentives."],
            ["13. Taxation & TDS: ", "All commissions and rewards are strictly subject to TDS and statutory government deductions."],
            ["14. Possession & Registry: ", "Company provides plot possession & mutation (Dakhil Kharij). Registry & stamp expenses borne by buyer."],
            ["15. Jurisdiction: ", "All disputes settled via mutual arbitration, subject exclusively to the courts of Unnao / Lucknow, UP."]
        ];

        doc.fontSize(7.5);
        policies.forEach(([title, text]) => {
            doc.fillColor("#14532d").font("Helvetica-Bold").text(title, 40, y, { continued: true });
            doc.fillColor("#1e293b").font("Helvetica").text(text, { width: 515, lineGap: 1 });
            y = doc.y + 4;
        });

        // 8. Associate Undertaking & Declaration Checkboxes
        y += 4;
        drawSectionTitle(doc, "8. Associate Undertakings & Code of Conduct Acceptance", y, 15);
        y += 20;

        const consents = [
            "I have read and understood the Commission Rules (Member Sales 5%, Associate Leader 0.5%) and Bonanza Reward terms.",
            "I agree to follow official ethical workflow: team training, site visits, and strictly NO cash transactions to individuals.",
            "I agree to Independent Contractor status, mandatory KYC verification, and minimum performance standards.",
            "I understand the Patrolling Allowance, Accidental Death & Disability Benefit terms, and strict financial liability policies.",
            "I agree to marketing guidelines, confidentiality, taxation/TDS deduction rules, and Unnao/Lucknow court jurisdiction.",
            "I confirm that all personal, bank, and nominee information furnished is true, correct, and legally accurate."
        ];

        consents.forEach((txt) => {
            drawCheckbox(doc, txt, 40, y, true);
            y += 16;
        });

        // Declaration Box
        y += 6;
        const declBoxY = y;
        const declBoxHeight = 44;
        doc.lineWidth(0.8).strokeColor("#cbd5e1").rect(40, declBoxY, 515, declBoxHeight).stroke();
        doc.rect(40.5, declBoxY + 0.5, 514, declBoxHeight - 1).fill("#f8fafc");
        doc.fillColor("#14532d").fontSize(7.5).font("Helvetica-Bold").text("DECLARATION UNDERTAKING:", 48, declBoxY + 6);
        doc.fillColor("#1e293b").fontSize(7.2).font("Helvetica").text(
            `I, ${associate.full_name || "—"}, hereby declare that all information furnished in this form is true, correct and complete to the best of my knowledge. I agree to all terms, commission structures, code of conduct, and business guidelines of M.M.R. Construction & Developers Pvt. Ltd. and request to enroll as an official Associate Partner.`,
            48, declBoxY + 18, { width: 499, lineGap: 1.5 }
        );

        // Signatures Section
        const sigTop = 670;
        if (applicantSignBuf && applicantSignBuf.length > 0) {
            try {
                doc.image(applicantSignBuf, 50, sigTop - 42, { fit: [180, 38], align: "center", valign: "center" });
            } catch (e) {
                console.warn("[associatePdfService] Error embedding applicant signature:", e);
            }
        }

        // Applicant Signature Line
        doc.lineWidth(0.8).strokeColor("#1e293b").moveTo(40, sigTop).lineTo(230, sigTop).stroke();
        doc.fillColor("#0f172a").fontSize(8).font("Helvetica-Bold");
        doc.text("Applicant Digital Signature", 40, sigTop + 5, { width: 190, align: "center" });
        doc.font("Helvetica").fontSize(7.5).text(`Date: ${signDateStr || "—"}`, 40, sigTop + 16, { width: 190, align: "center" });

        // Authorized Company Signatory Line
        doc.lineWidth(0.8).strokeColor("#1e293b").moveTo(365, sigTop).lineTo(555, sigTop).stroke();
        doc.fillColor("#0f172a").fontSize(8).font("Helvetica-Bold");
        doc.text("For M.M.R. Construction & Developers Pvt. Ltd.", 365, sigTop + 5, { width: 190, align: "center" });
        doc.font("Helvetica").fontSize(7.5).text("Authorized Signatory", 365, sigTop + 16, { width: 190, align: "center" });

        drawFooter(doc, 3, totalPages);
        doc.end();
    });
}
