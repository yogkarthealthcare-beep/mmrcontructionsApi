import PDFDocument from "pdfkit";
import sql from "../db.js";
import { resolveImageBuffer, drawPhotoBoxWithBuffer, drawSignatureBoxWithBuffer } from "./pdfImageHelper.js";

function drawHeader(doc: any, memberId: string | null | undefined, formDate: string) {
    const brandColor = "#14532d";
    doc.rect(40, 20, 515, 60).fill(brandColor);
    doc.fillColor("#ffffff").circle(75, 50, 20).fill();
    doc.fillColor(brandColor).fontSize(10).font("Helvetica-Bold").text("MMR", 63, 46);
    doc.fillColor("#ffffff").fontSize(13).font("Helvetica-Bold").text("M.M.R. CONSTRUCTION & DEVELOPERS PRIVATE", 110, 30);
    doc.text("LIMITED", 110, 44);
    doc.fontSize(7).font("Helvetica").text("Head Office: 05, Tribhuvan Khera, Sheshpur Nari", 110, 58);
    doc.text("Corporate Office: Unnao, Uttar Pradesh, India 209801", 110, 68);
    doc.fillColor("#ffffff").fontSize(7).font("Helvetica");
    doc.text("Ph No. 9511119879 | 8429823067", 380, 26, { align: "right", width: 170 });
    doc.text("GST No. 09AATCM6753A1Z5", 380, 35, { align: "right", width: 170 });
    doc.text("CIN No. U68200UP2025PTC229203", 380, 44, { align: "right", width: 170 });
    doc.text(`Team Member ID: ${memberId || "—"}`, 380, 53, { align: "right", width: 170 });
    doc.text(`Date: ${formDate || "—"}`, 380, 62, { align: "right", width: 170 });
}

function drawFooter(doc: any, pageNum: number, totalPages: number) {
    doc.fillColor("#64748b").fontSize(7).font("Helvetica");
    doc.text("Website: https://mmrconstructions.in/ | Email: mmrconstructions@hotmail.com", 40, 770, { align: "left" });
    doc.text(`Page ${pageNum} of ${totalPages}`, 400, 770, { align: "right", width: 155 });
}

function drawSectionTitle(doc: any, title: string, y: number) {
    doc.rect(40, y, 515, 18).fill("#14532d");
    doc.fillColor("#ffffff").fontSize(9).font("Helvetica-Bold").text(title, 48, y + 4);
}

function drawField(doc: any, label: string, value: any, x: number, y: number, width: number, labelWidth = 120) {
    doc.fillColor("#1e293b").fontSize(8.5).font("Helvetica-Bold").text(label, x, y, { width: labelWidth });
    const valueX = x + labelWidth + 5;
    const valueWidth = width - labelWidth - 5;
    doc.fillColor("#0f172a").font("Helvetica").text(String(value || "—"), valueX, y, { width: valueWidth });
    const lineY = y + 10;
    doc.lineWidth(0.5).strokeColor("#cbd5e1").dash(2, { space: 2 }).moveTo(valueX, lineY).lineTo(x + width, lineY).stroke().undash();
}

function drawCheckbox(doc: any, text: string, x: number, y: number, checked = true) {
    doc.lineWidth(1).strokeColor("#14532d").rect(x, y, 10, 10).stroke();
    if (checked) {
        doc.fillColor("#14532d").fontSize(8.5).font("Helvetica-Bold").text("✓", x + 1.5, y + 0.5);
    }
    doc.fillColor("#1e293b").fontSize(8).font("Helvetica").text(text, x + 16, y, { width: 490 });
}

export async function generateTeamMemberPdf(id: string | number): Promise<Buffer> {
    const isNum = !isNaN(Number(id));
    const [member] = isNum
        ? await (sql as any)`SELECT * FROM team_members WHERE id = ${Number(id)} OR team_member_uid = ${String(id)} LIMIT 1`
        : await (sql as any)`SELECT * FROM team_members WHERE team_member_uid = ${String(id)} LIMIT 1`;

    if (!member) {
        throw new Error(`Team member with ID ${id} not found.`);
    }

    const formDateStr = member.created_at ? new Date(member.created_at).toLocaleDateString("en-IN") : "";
    const dobStr = member.date_of_birth ? new Date(member.date_of_birth).toLocaleDateString("en-IN") : "";
    const finalSubmitDateStr = member.is_final_submitted ? (member.updated_at ? new Date(member.updated_at).toLocaleString("en-IN") : formDateStr) : "Not Final Submitted";

    const [photoBuf, applicantSigBuf, associateSigBuf] = await Promise.all([
        resolveImageBuffer(member.photo_url),
        resolveImageBuffer(member.applicant_signature_url),
        resolveImageBuffer(member.associate_signature_url)
    ]);

    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });

        doc.on("data", (chunk: Buffer) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", (err: any) => reject(err));

        const totalPages = 2;

        drawHeader(doc, member.team_member_uid, formDateStr);
        doc.fillColor("#14532d").fontSize(14).font("Helvetica-Bold").text("TEAM MEMBER ENROLLMENT FORM", 40, 105, { align: "center", width: 515 });
        drawPhotoBoxWithBuffer(doc, "Applicant", 475, 130, photoBuf);

        drawSectionTitle(doc, "1. Sponsor (Associate) Details", 130);
        let y = 158;
        drawField(doc, "Associate Name:", member.associate_name, 40, y, 420, 110);
        y += 24;
        drawField(doc, "Associate ID / User ID:", `ID #${member.associate_id}`, 40, y, 200, 110);
        drawField(doc, "Assigned Slot:", member.slot_number ? `Slot #${member.slot_number} of 10` : "—", 250, y, 170, 85);
        y += 24;
        drawField(doc, "Team Member UID:", member.team_member_uid, 40, y, 200, 110);
        drawField(doc, "Enrollment Status:", String(member.status || "pending").toUpperCase(), 250, y, 170, 95);

        y += 32;
        drawSectionTitle(doc, "2. Personal Details", y);
        y += 26;
        drawField(doc, "Full Name:", member.full_name, 40, y, 515, 110);
        y += 24;
        drawField(doc, "Father's / Husband's Name:", member.father_husband_name, 40, y, 515, 140);
        y += 24;
        drawField(doc, "Date of Birth:", dobStr, 40, y, 250, 110);
        drawField(doc, "Gender:", member.gender, 300, y, 255, 60);
        y += 24;
        drawField(doc, "Mobile Number:", member.mobile_no, 40, y, 250, 110);
        drawField(doc, "Email ID:", member.email_id, 300, y, 255, 60);
        y += 24;
        drawField(doc, "Aadhar Card Number:", member.aadhar_no, 40, y, 250, 110);
        drawField(doc, "PAN Card Number:", member.pan_no, 300, y, 255, 100);
        y += 24;
        drawField(doc, "Full Residential Address:", member.full_address, 40, y, 515, 140);

        drawFooter(doc, 1, totalPages);

        doc.addPage();
        drawHeader(doc, member.team_member_uid, formDateStr);

        drawSectionTitle(doc, "3. Nominee Details", 105);
        y = 132;
        drawField(doc, "Nominee Full Name:", member.nominee_name, 40, y, 250, 110);
        drawField(doc, "Relationship:", member.nominee_relation, 300, y, 255, 80);
        y += 24;
        drawField(doc, "Nominee Age / DOB:", member.nominee_age_dob, 40, y, 250, 110);
        drawField(doc, "Nominee Contact No.:", member.nominee_contact_no, 300, y, 255, 110);

        y += 34;
        drawSectionTitle(doc, "4. Bank Account Details", y);
        y += 26;
        drawField(doc, "Bank Name:", member.bank_name, 40, y, 250, 110);
        drawField(doc, "Branch Name:", member.branch_name, 300, y, 255, 80);
        y += 24;
        drawField(doc, "Account Number:", member.account_no, 40, y, 250, 110);
        drawField(doc, "IFSC Code:", member.ifsc_code, 300, y, 255, 80);

        y += 34;
        drawSectionTitle(doc, "5. Specimen Signatures", y);
        y += 22;
        drawSignatureBoxWithBuffer(doc, "Signature of Team Member (Applicant)", 40, y, applicantSigBuf, 240);
        drawSignatureBoxWithBuffer(doc, "Signature of Sponsoring Associate", 315, y, associateSigBuf, 240);

        y += 100;
        drawSectionTitle(doc, "6. Undertaking & Declaration Acceptance", y);
        y += 24;
        drawCheckbox(doc, "Applicant & Associate Undertaking: I hereby declare that all information furnished is true, and agree to adhere strictly to MMR code of conduct.", 40, y, Boolean(member.declaration_accepted));
        y += 24;
        drawField(doc, "Final Submission Status:", member.is_final_submitted ? "FINAL SUBMITTED (LOCKED)" : "DRAFT / UNLOCKED", 40, y, 250, 130);
        drawField(doc, "Final Submit Date/Time:", finalSubmitDateStr, 300, y, 255, 130);
        y += 24;
        drawField(doc, "Authorized Signatory:", member.authorized_signatory_name || "M.M.R. Construction & Developers Pvt. Ltd.", 40, y, 515, 130);

        drawFooter(doc, 2, totalPages);
    });
}
