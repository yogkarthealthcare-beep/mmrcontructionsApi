import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import sql from "../db.js";
import { getStorageRoot } from "./fileStorage.service.js";
// Helper to draw MMR header on each page
function drawHeader(doc, associateId, signDate) {
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
    doc.fontSize(7).font("Helvetica").text("Head Office: 00, Tribhuvan Khera, Sheshpur Nari", 110, 58);
    doc.text("Corporate Office: Unnao, Uttar Pradesh, India 209801", 110, 68);
    // Metadata Box on Right
    doc.fillColor("#ffffff").fontSize(7).font("Helvetica");
    doc.text("Ph No. 9511119879 | 8429823067", 380, 26, { align: "right", width: 170 });
    doc.text("GST No. 09AATCM6753A1Z5", 380, 35, { align: "right", width: 170 });
    doc.text("CIN No. U68200UP2025PTC229203", 380, 44, { align: "right", width: 170 });
    doc.text(`Associate ID: ${associateId || "—"}`, 380, 53, { align: "right", width: 170 });
    doc.text(`Submitted: ${signDate || "—"}`, 380, 62, { align: "right", width: 170 });
    // Red sample watermark banner
    doc.rect(40, 80, 515, 12).fill("#b3261e");
    doc.fillColor("#ffffff").fontSize(7).font("Helvetica-Bold").text("DUMMY / SAMPLE PRINTOUT", 40, 83, { align: "center", width: 515 });
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
        // Fallback placeholder text inside box
        doc.fillColor("#64748b").fontSize(6.5).font("Helvetica-Bold");
        doc.text(`PHOTO\n(${label})`, x, y + 42, { align: "center", width: boxWidth });
    }
}
export async function generateAssociatePdf(associateId) {
    // 1. Fetch data from DB
    const [associate] = await sql `SELECT * FROM associate_enrollment WHERE id = ${associateId}`;
    if (!associate) {
        throw new Error(`Associate with ID ${associateId} not found.`);
    }
    const addresses = await sql `SELECT * FROM associate_address WHERE associate_id = ${associateId}`;
    const [bank] = await sql `SELECT * FROM associate_bank_details WHERE associate_id = ${associateId}`;
    const [nominee] = await sql `SELECT * FROM associate_nominee WHERE associate_id = ${associateId}`;
    const [sponsor] = await sql `SELECT * FROM associate_sponsor WHERE associate_id = ${associateId}`;
    const permAddr = addresses.find((a) => a.address_type === "permanent") || {};
    const localAddr = addresses.find((a) => a.address_type === "local") || {};
    const signDateStr = associate.sign_date ? new Date(associate.sign_date).toLocaleDateString("en-IN") : "";
    const dobStr = associate.dob ? new Date(associate.dob).toLocaleDateString("en-IN") : "";
    const nomineeDobStr = nominee?.dob ? new Date(nominee.dob).toLocaleDateString("en-IN") : "";
    return new Promise((resolve, reject) => {
        const chunks = [];
        const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });
        doc.on("data", (chunk) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", (err) => reject(err));
        const totalPages = 5;
        // ─────────────────────────────────────────────────────────────────
        // PAGE 1: Personal Details
        // ─────────────────────────────────────────────────────────────────
        drawHeader(doc, associateId, signDateStr);
        doc.fillColor("#14532d").fontSize(14).font("Helvetica-Bold").text("ASSOCIATE ENROLLMENT FORM", 40, 110, { align: "center", width: 515 });
        // Photo box top-right
        drawPhotoBox(doc, "applicant", 475, 135, associate.applicant_photo_path);
        drawSectionTitle(doc, "Personal Details", 135);
        let y = 165;
        drawField(doc, "Full Name (only Adult):", associate.full_name, 40, y, 420, 110);
        y += 24;
        drawField(doc, "Date of Birth:", dobStr, 40, y, 200, 80);
        drawField(doc, "Gender:", associate.gender, 250, y, 210, 60);
        y += 24;
        drawField(doc, "Father's Name:", associate.father_name, 40, y, 420, 110);
        y += 24;
        drawField(doc, "Mother's Name:", associate.mother_name, 40, y, 420, 110);
        y += 24;
        drawField(doc, "Spouse's Name (Husband/Wife/Others):", associate.spouse_name, 40, y, 420, 190);
        // After photo height, we can use full width (515 pt)
        y += 28;
        drawField(doc, "Contact No. (i):", associate.contact_no_1, 40, y, 250, 90);
        drawField(doc, "(ii):", associate.contact_no_2, 300, y, 255, 30);
        y += 24;
        drawField(doc, "Nationality:", associate.nationality, 40, y, 250, 90);
        drawField(doc, "Residential Status:", associate.residential_status, 300, y, 255, 100);
        y += 24;
        drawField(doc, "Pan No.:", associate.pan_no, 40, y, 250, 90);
        drawField(doc, "Aadhar No.:", associate.aadhar_no, 300, y, 255, 100);
        y += 24;
        drawField(doc, "E-mail Id:", associate.email, 40, y, 515, 90);
        y += 24;
        drawField(doc, "Occupation:", associate.occupation, 40, y, 250, 90);
        drawField(doc, "Annual Income:", associate.annual_income, 300, y, 255, 100);
        y += 24;
        drawField(doc, "Education:", associate.education, 40, y, 250, 90);
        drawField(doc, "Category:", associate.category, 300, y, 255, 100);
        y += 24;
        drawField(doc, "Religion:", associate.religion, 40, y, 250, 90);
        drawFooter(doc, 1, totalPages);
        // ─────────────────────────────────────────────────────────────────
        // PAGE 2: Address Details & Bank Details
        // ─────────────────────────────────────────────────────────────────
        doc.addPage();
        drawHeader(doc, associateId, signDateStr);
        drawSectionTitle(doc, "Address Details", 115);
        y = 145;
        doc.fillColor("#14532d").fontSize(9).font("Helvetica-Bold").text("Permanent Address", 40, y);
        y += 15;
        drawField(doc, "Local Address:", permAddr.local_address, 40, y, 515, 90);
        y += 24;
        drawField(doc, "City/District:", permAddr.city, 40, y, 250, 90);
        drawField(doc, "State:", permAddr.state, 300, y, 255, 60);
        y += 24;
        drawField(doc, "Country:", permAddr.country, 40, y, 250, 90);
        drawField(doc, "Pin Code:", permAddr.pin_code, 300, y, 255, 60);
        y += 35;
        doc.fillColor("#14532d").fontSize(9).font("Helvetica-Bold").text("Local Address", 40, y);
        y += 15;
        drawField(doc, "Local Address:", localAddr.local_address, 40, y, 515, 90);
        y += 24;
        drawField(doc, "City/District:", localAddr.city, 40, y, 250, 90);
        drawField(doc, "State:", localAddr.state, 300, y, 255, 60);
        y += 24;
        drawField(doc, "Country:", localAddr.country, 40, y, 250, 90);
        drawField(doc, "Pin Code:", localAddr.pin_code, 300, y, 255, 60);
        y += 35;
        drawSectionTitle(doc, "Bank Details", y);
        y += 30;
        drawField(doc, "Bank Name:", bank?.bank_name, 40, y, 250, 90);
        drawField(doc, "Account Holder Name:", bank?.account_holder_name, 300, y, 255, 120);
        y += 24;
        drawField(doc, "Account No.:", bank?.account_no, 40, y, 250, 90);
        drawField(doc, "IFSC Code:", bank?.ifsc_code, 300, y, 255, 120);
        y += 24;
        drawField(doc, "MICR Code:", bank?.micr_code, 40, y, 250, 90);
        drawField(doc, "Branch Name:", bank?.branch_name, 300, y, 255, 120);
        y += 24;
        drawField(doc, "Branch Code:", bank?.branch_code, 40, y, 250, 90);
        drawField(doc, "Swift Code:", bank?.swift_code, 300, y, 255, 120);
        y += 24;
        drawField(doc, "Branch Country:", bank?.branch_country, 40, y, 250, 90);
        drawFooter(doc, 2, totalPages);
        // ─────────────────────────────────────────────────────────────────
        // PAGE 3: Nominee Details & Sponsor Details
        // ─────────────────────────────────────────────────────────────────
        doc.addPage();
        drawHeader(doc, associateId, signDateStr);
        drawSectionTitle(doc, "Nominee Details", 115);
        // Nominee photo box
        drawPhotoBox(doc, "nominee", 475, 135, nominee?.photo_path);
        y = 145;
        drawField(doc, "Nominee Name:", nominee?.nominee_name, 40, y, 420, 110);
        y += 24;
        drawField(doc, "Date of Birth:", nomineeDobStr, 40, y, 200, 80);
        drawField(doc, "Gender:", nominee?.gender, 250, y, 210, 60);
        y += 24;
        drawField(doc, "Nationality:", nominee?.nationality, 40, y, 200, 80);
        drawField(doc, "Residential Status:", nominee?.residential_status, 250, y, 210, 100);
        y += 24;
        drawField(doc, "Relationship:", nominee?.relationship, 40, y, 420, 110);
        y += 24;
        drawField(doc, "Pan Name:", nominee?.pan_name, 40, y, 250, 90);
        drawField(doc, "Pan No.:", nominee?.pan_no, 300, y, 255, 90);
        y += 24;
        drawField(doc, "Aadhar Name:", nominee?.aadhar_name, 40, y, 250, 90);
        drawField(doc, "Aadhar No.:", nominee?.aadhar_no, 300, y, 255, 90);
        y += 28;
        drawField(doc, "Nominee Address:", nominee?.address, 40, y, 515, 110);
        y += 40;
        drawSectionTitle(doc, "Sponsor Details", y);
        y += 30;
        drawField(doc, "Sponsor's/Introducer's Name:", sponsor?.sponsor_name, 40, y, 515, 150);
        y += 24;
        drawField(doc, "Code No.:", sponsor?.sponsor_code, 40, y, 250, 90);
        drawField(doc, "Contact No.:", sponsor?.sponsor_contact, 300, y, 255, 90);
        y += 24;
        drawField(doc, "Sponsor's/Introducer's Signature:", "(on file — image attached)", 40, y, 515, 170);
        drawFooter(doc, 3, totalPages);
        // ─────────────────────────────────────────────────────────────────
        // PAGE 4: Terms & Conditions (Part 1)
        // ─────────────────────────────────────────────────────────────────
        doc.addPage();
        drawHeader(doc, associateId, signDateStr);
        drawSectionTitle(doc, "Terms & Conditions", 115);
        doc.fillColor("#1e293b").fontSize(8).font("Helvetica");
        let tcY = 145;
        const tc1Text = "1. Registration & KYC: Associate ID registration is absolutely free and linked to their Aadhar and PAN cards. Full KYC verification is mandatory.";
        doc.font("Helvetica-Bold").text("1. Registration & KYC: ", 40, tcY, { continued: true }).font("Helvetica").text("Associate ID registration is absolutely free and linked to their Aadhar and PAN cards. Full KYC verification is mandatory.");
        tcY += 24;
        doc.font("Helvetica-Bold").text("2. Independent Contractor: ", 40, tcY, { continued: true }).font("Helvetica").text("The Associate acts as an independent channel partner and not as a regular employee of the company. No standard employment benefits are applicable.");
        tcY += 24;
        doc.font("Helvetica-Bold").text("3. Commission on Sales: ", 40, tcY, { continued: true }).font("Helvetica").text("An associate will earn a 5% commission based on the fixed company prescribed rates.");
        tcY += 16;
        doc.font("Helvetica-Bold").text("4. Member Sales (Commission Rule 1): ", 40, tcY, { continued: true }).font("Helvetica").text("If a Team Member successfully sells a plot, they will receive a direct 5% commission on their sale. On this specific sale, their Associate (Leader) will receive 0.5% commission (as Passive Income).");
        tcY += 24;
        doc.font("Helvetica-Bold").text("5. Associate Sales (Commission Rule 2): ", 40, tcY, { continued: true }).font("Helvetica").text("If the Associate (Leader) themselves sells a plot, they will receive a direct 5% commission on their sale.");
        tcY += 16;
        doc.font("Helvetica-Bold").text("6. Target & Bonanza Rewards: ", 40, tcY, { continued: true }).font("Helvetica").text("Sales targets for the selling individual (Associate or Member) will be evaluated over a 6-month timeframe. Upon achieving set targets, the company will award Bonanza prizes ranging from a smartphone to a car, along with a monthly Patrolling Allowance.");
        tcY += 24;
        doc.font("Helvetica-Bold").text("7. Patrolling Allowance (Mega Target): ", 40, tcY, { continued: true }).font("Helvetica").text("If an associate achieves a total sale of 2000 sq. yards, the company will provide a patrolling (travel) allowance of ₹12,000 per month for a duration of 72 months (6 years).");
        // Table drawing
        tcY += 32;
        const tableTop = tcY;
        const colWidths = [30, 90, 80, 315];
        const headers = ["Sr.", "Sales Target", "Offer Value", "Suggested Reward Items"];
        // Draw header row background
        doc.rect(40, tableTop, 515, 18).fill("#14532d");
        // Draw headers
        doc.fillColor("#ffffff").fontSize(7.5).font("Helvetica-Bold");
        let currentX = 40;
        headers.forEach((h, idx) => {
            doc.text(h, currentX + 5, tableTop + 5, { width: colWidths[idx] - 10, align: idx === 3 ? "left" : "center" });
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
        let rowY = tableTop + 18;
        doc.fillColor("#0f172a").fontSize(7).font("Helvetica");
        rows.forEach((row, rowIdx) => {
            // Alternating row background
            if (rowIdx % 2 === 1) {
                doc.rect(40, rowY, 515, 16).fill("#f8fafc");
            }
            doc.fillColor("#0f172a");
            let rx = 40;
            row.forEach((cell, colIdx) => {
                doc.text(cell, rx + 5, rowY + 4, { width: colWidths[colIdx] - 10, align: colIdx === 3 ? "left" : "center" });
                rx += colWidths[colIdx];
            });
            // Horizontal line
            doc.lineWidth(0.5).strokeColor("#cbd5e1").moveTo(40, rowY + 16).lineTo(555, rowY + 16).stroke();
            rowY += 16;
        });
        // Outer borders & vertical columns
        doc.lineWidth(0.5).strokeColor("#94a3b8");
        doc.rect(40, tableTop, 515, rowY - tableTop).stroke();
        let vx = 40;
        for (let i = 0; i < colWidths.length - 1; i++) {
            vx += colWidths[i];
            doc.moveTo(vx, tableTop).lineTo(vx, rowY).stroke();
        }
        drawFooter(doc, 4, totalPages);
        // ─────────────────────────────────────────────────────────────────
        // PAGE 5: Terms & Conditions (Part 2) + Declaration
        // ─────────────────────────────────────────────────────────────────
        doc.addPage();
        drawHeader(doc, associateId, signDateStr);
        drawSectionTitle(doc, "Terms & Conditions (contd.)", 115);
        doc.fillColor("#1e293b").fontSize(8).font("Helvetica");
        let tcY2 = 145;
        doc.font("Helvetica-Bold").text("8. Accidental Death Benefit: ", 40, tcY2, { continued: true }).font("Helvetica").text("In the unfortunate event of an associate's accidental death during active tenure, the company will provide their nominee with financial assistance of ₹3,00,000 or a registered plot of 50 sq. yards.");
        tcY2 += 22;
        doc.font("Helvetica-Bold").text("9. Accidental Disability Benefit: ", 40, tcY2, { continued: true }).font("Helvetica").text("If an associate suffers an accidental injury resulting in physical disability (loss of limbs), the company will provide financial aid ranging from ₹25,000 to ₹1,00,000 based on the condition.");
        tcY2 += 22;
        doc.font("Helvetica-Bold").text("10. Financial Liability: ", 40, tcY2, { continued: true }).font("Helvetica").text("The company is not responsible for any cash collected by the associate. The associate is strictly liable for its safe deposit into the company's bank account against a valid company receipt.");
        tcY2 += 22;
        doc.font("Helvetica-Bold").text("11. Marketing & Confidentiality: ", 40, tcY2, { continued: true }).font("Helvetica").text("Associates must use only company-approved marketing materials and must protect company data, client leads, and trade secrets without sharing them with competitors.");
        tcY2 += 22;
        doc.font("Helvetica-Bold").text("12. Termination for Misconduct: ", 40, tcY2, { continued: true }).font("Helvetica").text("Misleading customers, fake commitments, fraud, mis-selling or forgery will lead to immediate termination of ID and forfeiture of pending projects/payouts.");
        tcY2 += 22;
        doc.font("Helvetica-Bold").text("13. Taxation & TDS: ", 40, tcY2, { continued: true }).font("Helvetica").text("All commissions, allowances and rewards are subject to TDS and applicable statutory tax deductions as per government rules.");
        tcY2 += 16;
        doc.font("Helvetica-Bold").text("14. Possession & Registry: ", 40, tcY2, { continued: true }).font("Helvetica").text("The company is responsible for handing over possession and registry (Dakhil Kharij / mutation) to the customer. All registry and legal expenses will be strictly borne by the customer.");
        tcY2 += 22;
        doc.font("Helvetica-Bold").text("15. Jurisdiction: ", 40, tcY2, { continued: true }).font("Helvetica").text("In case of any dispute, it shall be settled by mutual arbitration and subject to the exclusive jurisdiction of the courts at Unnao / Lucknow.");
        // Draw the 6 checkboxes in ticked state
        tcY2 += 20;
        const consents = [
            "I have read and understood the Commission Rules (Member Sales & Associate Sales) and Target/Bonanza Reward terms.",
            "I have read and understood the Associate & Team Workflow (Team Building, Marketing & Site Visit, Deal Closure — including the \"no cash to individuals\" rule).",
            "I have read and understood the Registration, KYC, Independent Contractor status, Commission Rate and Base Sales Target terms.",
            "I have read and understood the Patrolling Allowance, Accidental Death Benefit, Disability Benefit and Financial Liability clauses.",
            "I have read and understood the Marketing, Confidentiality, Misconduct, Taxation/TDS, Termination, Possession/Registry and Jurisdiction clauses.",
            "I confirm the Declaration — all information provided by me is true and correct, and I agree to associate with M.M.R. Construction & Developers Pvt. Ltd. under the above terms."
        ];
        consents.forEach((txt) => {
            drawCheckbox(doc, txt, 40, tcY2, true);
            tcY2 += 18;
        });
        // Declaration block inside grey box
        tcY2 += 6;
        doc.lineWidth(1).strokeColor("#cbd5e1").rect(40, tcY2, 515, 45).stroke();
        doc.rect(41, tcY2 + 1, 513, 43).fill("#f8fafc");
        doc.fillColor("#1e293b").fontSize(7.5).font("Helvetica-Bold");
        doc.text("Declaration: ", 46, tcY2 + 6, { continued: true });
        doc.font("Helvetica").text(`I, ${associate.full_name || "—"}, hereby declare that all the above information is true & correct to my best knowledge and wish to associate with the company as per the above mentioned terms and conditions. I agree with all the above details, terms and conditions and am requested to consider my above details.`, { width: 503, lineGap: 2 });
        // Signature section
        const sigTop = 710;
        doc.lineWidth(1).strokeColor("#1e293b").moveTo(40, sigTop).lineTo(240, sigTop).stroke();
        doc.moveTo(355, sigTop).lineTo(555, sigTop).stroke();
        doc.fillColor("#0f172a").fontSize(8.5).font("Helvetica-Bold");
        doc.text("Applicant Signature", 40, sigTop + 6, { width: 200, align: "center" });
        doc.text(`Date: ${signDateStr || "—"}`, 40, sigTop + 18, { width: 200, align: "center" });
        doc.text("For M.M.R. Construction & Developers Pvt. Ltd.", 355, sigTop + 6, { width: 200, align: "center" });
        doc.font("Helvetica").text("Authorized Signatory", 355, sigTop + 18, { width: 200, align: "center" });
        drawFooter(doc, 5, totalPages);
        doc.end();
    });
}
