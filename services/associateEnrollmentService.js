import { z } from "zod";
import sql from "../db.js";
// Validation schema for defense in depth
export const associateEnrollmentSchema = z.object({
    fullName: z.string().min(1, "Full name is required"),
    dob: z.string().min(1, "Date of birth is required"),
    gender: z.string().min(1, "Gender is required"),
    fatherName: z.string().optional().nullable(),
    motherName: z.string().optional().nullable(),
    spouseName: z.string().optional().nullable(),
    contact1: z.string().min(10, "Contact number 1 must be at least 10 digits").max(15),
    contact2: z.string().optional().nullable(),
    nationality: z.string().default("Indian"),
    residentialStatus: z.string().optional().nullable(),
    panNo: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, "Invalid PAN format"),
    aadharNo: z.string().regex(/^[0-9]{12}$/, "Aadhar number must be 12 digits"),
    email: z.string().email("Invalid email format").optional().nullable().or(z.literal("")),
    occupation: z.string().optional().nullable(),
    annualIncome: z.string().optional().nullable(),
    education: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    religion: z.string().optional().nullable(),
    signDate: z.string().optional().nullable(),
    termsAccepted: z.preprocess((val) => val === "true" || val === true, z.boolean().refine((val) => val === true, "All terms must be accepted")),
    // Address Details
    permAddress: z.string().optional().nullable(),
    permCity: z.string().optional().nullable(),
    permState: z.string().optional().nullable(),
    permCountry: z.string().default("India"),
    permPin: z.string().optional().nullable(),
    localAddress: z.string().optional().nullable(),
    localCity: z.string().optional().nullable(),
    localState: z.string().optional().nullable(),
    localCountry: z.string().default("India"),
    localPin: z.string().optional().nullable(),
    // Bank Details
    bankName: z.string().optional().nullable(),
    accHolder: z.string().optional().nullable(),
    accNo: z.string().optional().nullable(),
    ifsc: z.string().optional().nullable(),
    micr: z.string().optional().nullable(),
    branchName: z.string().optional().nullable(),
    branchCode: z.string().optional().nullable(),
    swift: z.string().optional().nullable(),
    branchCountry: z.string().default("India"),
    // Nominee Details
    nomineeName: z.string().optional().nullable(),
    nomineeDob: z.string().optional().nullable(),
    nomineeGender: z.string().optional().nullable(),
    nomineeNationality: z.string().default("Indian"),
    nomineeResStatus: z.string().optional().nullable(),
    nomineeRelationship: z.string().optional().nullable(),
    nomineePanName: z.string().optional().nullable(),
    nomineePanNo: z.string().optional().nullable(),
    nomineeAadharName: z.string().optional().nullable(),
    nomineeAadharNo: z.string().optional().nullable(),
    nomineeAddress: z.string().optional().nullable(),
    // Sponsor Details
    sponsorName: z.string().optional().nullable(),
    sponsorCode: z.string().optional().nullable(),
    sponsorContact: z.string().optional().nullable()
});
/**
 * Register a new associate enrollment and related details in a single database transaction.
 */
export async function registerAssociateEnrollment(data, applicantPhotoPath, nomineePhotoPath, userId = null) {
    const year = new Date().getFullYear();
    let generatedId = "";
    // Perform inside transaction so that failure in any step rolls back everything
    await sql.begin(async (tx) => {
        try {
            await tx`ALTER TABLE associate_enrollment ADD COLUMN IF NOT EXISTS user_id INTEGER`;
        } catch (e) {}

        // 1. Generate unique chronological Associate ID
        // Format: MMR-ASC-YYYY-XXXX (where XXXX is a sequential 4-digit number starting at 0001)
        const [countResult] = await tx `
      SELECT COUNT(*)::integer as cnt 
      FROM associate_enrollment 
      WHERE id LIKE ${`MMR-ASC-${year}-%`}
    `;
        const count = (countResult?.cnt || 0) + 1;
        generatedId = `MMR-ASC-${year}-${String(count).padStart(4, "0")}`;
        // 2. Insert master: associate_enrollment
        await tx `
      INSERT INTO associate_enrollment (
        id, user_id, full_name, dob, gender, father_name, mother_name, spouse_name,
        contact_no_1, contact_no_2, nationality, residential_status,
        pan_no, aadhar_no, email, occupation, annual_income, education,
        category, religion, applicant_photo_path, sign_date,
        terms_accepted, terms_accepted_at, status
      ) VALUES (
        ${generatedId}, ${userId || null}, ${data.fullName}, ${data.dob}, ${data.gender}, ${data.fatherName || null}, ${data.motherName || null}, ${data.spouseName || null},
        ${data.contact1}, ${data.contact2 || null}, ${data.nationality}, ${data.residentialStatus || null},
        ${data.panNo.toUpperCase()}, ${data.aadharNo}, ${data.email || null}, ${data.occupation || null}, ${data.annualIncome || null}, ${data.education || null},
        ${data.category || null}, ${data.religion || null}, ${applicantPhotoPath}, ${data.signDate || null},
        ${data.termsAccepted}, NOW(), 'pending'
      )
    `;
        // 3. Insert address: permanent & local
        if (data.permAddress) {
            await tx `
        INSERT INTO associate_address (
          associate_id, address_type, local_address, city, state, country, pin_code
        ) VALUES (
          ${generatedId}, 'permanent', ${data.permAddress}, ${data.permCity || null}, ${data.permState || null}, ${data.permCountry}, ${data.permPin || null}
        )
      `;
        }
        if (data.localAddress) {
            await tx `
        INSERT INTO associate_address (
          associate_id, address_type, local_address, city, state, country, pin_code
        ) VALUES (
          ${generatedId}, 'local', ${data.localAddress}, ${data.localCity || null}, ${data.localState || null}, ${data.localCountry}, ${data.localPin || null}
        )
      `;
        }
        // 4. Insert bank details
        if (data.bankName || data.accNo || data.ifsc) {
            await tx `
        INSERT INTO associate_bank_details (
          associate_id, bank_name, account_holder_name, account_no, ifsc_code,
          micr_code, branch_name, branch_code, swift_code, branch_country
        ) VALUES (
          ${generatedId}, ${data.bankName || null}, ${data.accHolder || null}, ${data.accNo || null}, ${data.ifsc || null},
          ${data.micr || null}, ${data.branchName || null}, ${data.branchCode || null}, ${data.swift || null}, ${data.branchCountry}
        )
      `;
        }
        // 5. Insert nominee details
        if (data.nomineeName) {
            await tx `
        INSERT INTO associate_nominee (
          associate_id, nominee_name, dob, gender, nationality, residential_status,
          relationship, pan_name, pan_no, aadhar_name, aadhar_no, address, photo_path
        ) VALUES (
          ${generatedId}, ${data.nomineeName}, ${data.nomineeDob || null}, ${data.nomineeGender || null},
          ${data.nomineeNationality}, ${data.nomineeResStatus || null}, ${data.nomineeRelationship || null},
          ${data.nomineePanName || null}, ${data.nomineePanNo || null}, ${data.nomineeAadharName || null},
          ${data.nomineeAadharNo || null}, ${data.nomineeAddress || null}, ${nomineePhotoPath}
        )
      `;
        }
        // 6. Insert sponsor details
        if (data.sponsorName || data.sponsorCode) {
            await tx `
        INSERT INTO associate_sponsor (
          associate_id, sponsor_name, sponsor_code, sponsor_contact
        ) VALUES (
          ${generatedId}, ${data.sponsorName || null}, ${data.sponsorCode || null}, ${data.sponsorContact || null}
        )
      `;
        }

        // 7. Update user enrollment_status
        if (userId) {
            try {
                await tx`UPDATE users SET enrollment_status = 'Completed' WHERE user_id = ${userId}`;
            } catch (e) {}
        }
    });
    return { associateId: generatedId };
}

function formatAssociateEnrollment(master, addresses = [], bankDetails = [], nominee = [], sponsor = []) {
    const permAddr = addresses.find(a => a.address_type === 'permanent') || {};
    const localAddr = addresses.find(a => a.address_type === 'local') || {};
    const bank = bankDetails[0] || {};
    const nom = nominee[0] || {};
    const sp = sponsor[0] || {};

    return {
        ...master,
        associate_id: master.id,
        associateId: master.id,
        
        // Permanent Address
        permAddress: permAddr.local_address || '',
        perm_address: permAddr.local_address || '',
        permCity: permAddr.city || '',
        perm_city: permAddr.city || '',
        permState: permAddr.state || '',
        perm_state: permAddr.state || '',
        permCountry: permAddr.country || 'India',
        perm_country: permAddr.country || 'India',
        permPin: permAddr.pin_code || '',
        perm_pin: permAddr.pin_code || '',

        // Local Address
        localAddress: localAddr.local_address || '',
        local_address: localAddr.local_address || '',
        localCity: localAddr.city || '',
        local_city: localAddr.city || '',
        localState: localAddr.state || '',
        local_state: localAddr.state || '',
        localCountry: localAddr.country || 'India',
        local_country: localAddr.country || 'India',
        localPin: localAddr.pin_code || '',
        local_pin: localAddr.pin_code || '',

        // Bank Details
        bankName: bank.bank_name || '',
        bank_name: bank.bank_name || '',
        accHolder: bank.account_holder_name || '',
        acc_holder: bank.account_holder_name || '',
        acc_holder_name: bank.account_holder_name || '',
        accNo: bank.account_no || '',
        acc_no: bank.account_no || '',
        account_no: bank.account_no || '',
        ifsc: bank.ifsc_code || '',
        ifsc_code: bank.ifsc_code || '',
        micr: bank.micr_code || '',
        micr_code: bank.micr_code || '',
        branchName: bank.branch_name || '',
        branch_name: bank.branch_name || '',
        branchCode: bank.branch_code || '',
        branch_code: bank.branch_code || '',
        swift: bank.swift_code || '',
        swift_code: bank.swift_code || '',
        branchCountry: bank.branch_country || 'India',
        branch_country: bank.branch_country || 'India',

        // Nominee Details
        nomineeName: nom.nominee_name || '',
        nominee_name: nom.nominee_name || '',
        nomineeDob: nom.dob || '',
        nominee_dob: nom.dob || '',
        nomineeGender: nom.gender || '',
        nominee_gender: nom.gender || '',
        nomineeNationality: nom.nationality || 'Indian',
        nominee_nationality: nom.nationality || 'Indian',
        nomineeResStatus: nom.residential_status || '',
        nominee_res_status: nom.residential_status || '',
        nomineeRelationship: nom.relationship || '',
        nominee_relationship: nom.relationship || '',
        nomineePanName: nom.pan_name || '',
        nominee_pan_name: nom.pan_name || '',
        nomineePanNo: nom.pan_no || '',
        nominee_pan_no: nom.pan_no || '',
        nomineeAadharName: nom.aadhar_name || '',
        nominee_aadhar_name: nom.aadhar_name || '',
        nomineeAadharNo: nom.aadhar_no || '',
        nominee_aadhar_no: nom.aadhar_no || '',
        nomineeAddress: nom.address || '',
        nominee_address: nom.address || '',
        nomineePhotoPath: nom.photo_path || '',
        nominee_photo_path: nom.photo_path || '',
        nomineePhotoUrl: nom.photo_path || '',
        nominee_photo_url: nom.photo_path || '',

        // Sponsor Details
        sponsorName: sp.sponsor_name || '',
        sponsor_name: sp.sponsor_name || '',
        sponsorCode: sp.sponsor_code || '',
        sponsor_code: sp.sponsor_code || '',
        sponsorContact: sp.sponsor_contact || '',
        sponsor_contact: sp.sponsor_contact || '',

        // Contacts & Photos
        contact1: master.contact_no_1 || '',
        contact_1: master.contact_no_1 || '',
        contact2: master.contact_no_2 || '',
        contact_2: master.contact_no_2 || '',
        applicantPhotoUrl: master.applicant_photo_path || '',
        applicant_photo_url: master.applicant_photo_path || '',
    };
}

/**
 * Fetch full associate enrollment details for a user (by userId, mobile, or email)
 */
export async function getAssociateEnrollmentByUserId(userId, mobile = null, email = null) {
    try {
        await sql`ALTER TABLE associate_enrollment ADD COLUMN IF NOT EXISTS user_id INTEGER`;
    } catch (e) {}

    let rows;
    if (userId) {
        rows = await sql`SELECT * FROM associate_enrollment WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`;
    }
    if ((!rows || rows.length === 0) && mobile) {
        rows = await sql`SELECT * FROM associate_enrollment WHERE contact_no_1 = ${mobile} ORDER BY created_at DESC LIMIT 1`;
    }
    if ((!rows || rows.length === 0) && email) {
        rows = await sql`SELECT * FROM associate_enrollment WHERE LOWER(email) = LOWER(${email}) ORDER BY created_at DESC LIMIT 1`;
    }

    if (!rows || rows.length === 0) return null;
    const master = rows[0];

    const addresses = await sql`SELECT * FROM associate_address WHERE associate_id = ${master.id}`;
    const bankDetails = await sql`SELECT * FROM associate_bank_details WHERE associate_id = ${master.id} LIMIT 1`;
    const nominee = await sql`SELECT * FROM associate_nominee WHERE associate_id = ${master.id} LIMIT 1`;
    const sponsor = await sql`SELECT * FROM associate_sponsor WHERE associate_id = ${master.id} LIMIT 1`;

    return formatAssociateEnrollment(master, addresses, bankDetails, nominee, sponsor);
}

/**
 * List all associates for Admin with universal search & enrollment status
 */
export async function adminListAssociateEnrollments(search = "") {
    try {
        await sql`ALTER TABLE associate_enrollment ADD COLUMN IF NOT EXISTS user_id INTEGER`;
    } catch (e) {}

    const s = String(search || "").trim();
    if (s) {
        const pattern = `%${s}%`;
        return await sql`
          SELECT 
            u.user_id,
            u.full_name,
            u.email,
            u.mobile_no,
            u.member_id,
            u.user_type,
            u.registered_at,
            sp.member_id as sponsor_id,
            sp.full_name as sponsor_name,
            ae.id as submission_id,
            ae.id as associate_enrollment_id,
            ae.status as application_status,
            ae.created_at as submitted_at,
            CASE WHEN ae.id IS NOT NULL THEN 'Completed' ELSE COALESCE(u.enrollment_status, 'Pending') END as enrollment_status
          FROM users u
          LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
          LEFT JOIN associate_enrollment ae ON (u.user_id = ae.user_id OR u.mobile_no = ae.contact_no_1)
          WHERE u.user_type = 'Associate'
            AND (
              u.full_name ILIKE ${pattern}
              OR u.mobile_no ILIKE ${pattern}
              OR u.email ILIKE ${pattern}
              OR u.member_id ILIKE ${pattern}
              OR sp.member_id ILIKE ${pattern}
              OR ae.id ILIKE ${pattern}
            )
          ORDER BY u.registered_at DESC
        `;
    } else {
        return await sql`
          SELECT 
            u.user_id,
            u.full_name,
            u.email,
            u.mobile_no,
            u.member_id,
            u.user_type,
            u.registered_at,
            sp.member_id as sponsor_id,
            sp.full_name as sponsor_name,
            ae.id as submission_id,
            ae.id as associate_enrollment_id,
            ae.status as application_status,
            ae.created_at as submitted_at,
            CASE WHEN ae.id IS NOT NULL THEN 'Completed' ELSE COALESCE(u.enrollment_status, 'Pending') END as enrollment_status
          FROM users u
          LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
          LEFT JOIN associate_enrollment ae ON (u.user_id = ae.user_id OR u.mobile_no = ae.contact_no_1)
          WHERE u.user_type = 'Associate'
          ORDER BY u.registered_at DESC
        `;
    }
}

/**
 * Get associate enrollment by master ID (e.g. MMR-ASC-YYYY-XXXX or user_id)
 */
export async function adminGetAssociateEnrollmentById(id) {
    let rows;
    if (String(id).startsWith("MMR-ASC-")) {
        rows = await sql`SELECT * FROM associate_enrollment WHERE id = ${id}`;
    } else {
        rows = await sql`SELECT * FROM associate_enrollment WHERE id = ${id} OR user_id = ${Number(id) || 0} ORDER BY created_at DESC LIMIT 1`;
    }

    if (!rows || rows.length === 0) {
        // Return user profile info if no enrollment submission yet
        const [user] = await sql`
          SELECT u.user_id, u.full_name, u.email, u.mobile_no, u.member_id, u.date_of_birth, u.gender, u.father_name, u.mother_name, u.pan_number, u.aadhar_number,
                 sp.member_id as sponsor_id, sp.full_name as sponsor_name
          FROM users u
          LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
          WHERE u.user_id = ${Number(id) || 0}
        `;
        if (user) {
            return {
                user_id: user.user_id,
                full_name: user.full_name,
                contact_no_1: user.mobile_no,
                email: user.email,
                pan_no: user.pan_number || '',
                aadhar_no: user.aadhar_number || '',
                dob: user.date_of_birth || '',
                gender: user.gender || '',
                father_name: user.father_name || '',
                sponsorCode: user.sponsor_id || '',
                sponsorName: user.sponsor_name || '',
                is_new: true
            };
        }
        return null;
    }

    const master = rows[0];
    const addresses = await sql`SELECT * FROM associate_address WHERE associate_id = ${master.id}`;
    const bankDetails = await sql`SELECT * FROM associate_bank_details WHERE associate_id = ${master.id} LIMIT 1`;
    const nominee = await sql`SELECT * FROM associate_nominee WHERE associate_id = ${master.id} LIMIT 1`;
    const sponsor = await sql`SELECT * FROM associate_sponsor WHERE associate_id = ${master.id} LIMIT 1`;

    return formatAssociateEnrollment(master, addresses, bankDetails, nominee, sponsor);
}

/**
 * Full update for Associate Enrollment by Admin
 */
export async function adminUpdateAssociateEnrollment(id, data, applicantPhotoPath = null, nomineePhotoPath = null) {
    let targetId = id;
    let existing;
    if (String(id).startsWith("MMR-ASC-")) {
        const [row] = await sql`SELECT * FROM associate_enrollment WHERE id = ${id}`;
        existing = row;
    } else {
        const [row] = await sql`SELECT * FROM associate_enrollment WHERE id = ${id} OR user_id = ${Number(id) || 0} ORDER BY created_at DESC LIMIT 1`;
        existing = row;
    }

    if (!existing) {
        throw new Error("Associate enrollment not found.");
    }
    targetId = existing.id;

    await sql.begin(async (tx) => {
        await tx`
          UPDATE associate_enrollment
          SET
            full_name = COALESCE(${data.fullName || data.full_name || null}, full_name),
            dob = COALESCE(${data.dob || null}, dob),
            gender = COALESCE(${data.gender || null}, gender),
            father_name = ${data.fatherName ?? data.father_name ?? null},
            mother_name = ${data.motherName ?? data.mother_name ?? null},
            spouse_name = ${data.spouseName ?? data.spouse_name ?? null},
            contact_no_1 = COALESCE(${data.contact1 || data.contact_no_1 || null}, contact_no_1),
            contact_no_2 = ${data.contact2 ?? data.contact_no_2 ?? null},
            nationality = COALESCE(${data.nationality || null}, nationality),
            residential_status = ${data.residentialStatus ?? data.residential_status ?? null},
            pan_no = COALESCE(${data.panNo?.toUpperCase() || data.pan_no?.toUpperCase() || null}, pan_no),
            aadhar_no = COALESCE(${data.aadharNo || data.aadhar_no || null}, aadhar_no),
            email = ${data.email ?? null},
            occupation = ${data.occupation ?? null},
            annual_income = ${data.annualIncome ?? data.annual_income ?? null},
            education = ${data.education ?? null},
            category = ${data.category ?? null},
            religion = ${data.religion ?? null},
            applicant_photo_path = COALESCE(${applicantPhotoPath}, applicant_photo_path),
            sign_date = COALESCE(${data.signDate || data.sign_date || null}, sign_date),
            status = COALESCE(${data.status || null}, status),
            updated_at = NOW()
          WHERE id = ${targetId}
        `;

        // Update permanent address
        const pAddr = data.permAddress !== undefined ? data.permAddress : data.perm_address;
        if (pAddr !== undefined) {
            await tx`DELETE FROM associate_address WHERE associate_id = ${targetId} AND address_type = 'permanent'`;
            await tx`
              INSERT INTO associate_address (associate_id, address_type, local_address, city, state, country, pin_code)
              VALUES (${targetId}, 'permanent', ${pAddr || null}, ${data.permCity || data.perm_city || null}, ${data.permState || data.perm_state || null}, ${data.permCountry || data.perm_country || 'India'}, ${data.permPin || data.perm_pin || null})
            `;
        }
        // Update local address
        const lAddr = data.localAddress !== undefined ? data.localAddress : data.local_address;
        if (lAddr !== undefined) {
            await tx`DELETE FROM associate_address WHERE associate_id = ${targetId} AND address_type = 'local'`;
            await tx`
              INSERT INTO associate_address (associate_id, address_type, local_address, city, state, country, pin_code)
              VALUES (${targetId}, 'local', ${lAddr || null}, ${data.localCity || data.local_city || null}, ${data.localState || data.local_state || null}, ${data.localCountry || data.local_country || 'India'}, ${data.localPin || data.local_pin || null})
            `;
        }
        // Update bank details
        const bName = data.bankName !== undefined ? data.bankName : data.bank_name;
        const aNo = data.accNo !== undefined ? data.accNo : (data.acc_no !== undefined ? data.acc_no : data.account_no);
        const ifscVal = data.ifsc !== undefined ? data.ifsc : data.ifsc_code;
        if (bName !== undefined || aNo !== undefined || ifscVal !== undefined) {
            await tx`DELETE FROM associate_bank_details WHERE associate_id = ${targetId}`;
            await tx`
              INSERT INTO associate_bank_details (associate_id, bank_name, account_holder_name, account_no, ifsc_code, micr_code, branch_name, branch_code, swift_code, branch_country)
              VALUES (${targetId}, ${bName || null}, ${data.accHolder || data.acc_holder || data.acc_holder_name || null}, ${aNo || null}, ${ifscVal || null}, ${data.micr || data.micr_code || null}, ${data.branchName || data.branch_name || null}, ${data.branchCode || data.branch_code || null}, ${data.swift || data.swift_code || null}, ${data.branchCountry || data.branch_country || 'India'})
            `;
        }
        // Update nominee
        const nomName = data.nomineeName !== undefined ? data.nomineeName : data.nominee_name;
        if (nomName !== undefined) {
            await tx`DELETE FROM associate_nominee WHERE associate_id = ${targetId}`;
            await tx`
              INSERT INTO associate_nominee (associate_id, nominee_name, dob, gender, nationality, residential_status, relationship, pan_name, pan_no, aadhar_name, aadhar_no, address, photo_path)
              VALUES (${targetId}, ${nomName || null}, ${data.nomineeDob || data.nominee_dob || null}, ${data.nomineeGender || data.nominee_gender || null}, ${data.nomineeNationality || data.nominee_nationality || 'Indian'}, ${data.nomineeResStatus || data.nominee_res_status || null}, ${data.nomineeRelationship || data.nominee_relationship || null}, ${data.nomineePanName || data.nominee_pan_name || null}, ${data.nomineePanNo || data.nominee_pan_no || null}, ${data.nomineeAadharName || data.nominee_aadhar_name || null}, ${data.nomineeAadharNo || data.nominee_aadhar_no || null}, ${data.nomineeAddress || data.nominee_address || null}, ${nomineePhotoPath || null})
            `;
        }
        // Update sponsor
        const spName = data.sponsorName !== undefined ? data.sponsorName : data.sponsor_name;
        const spCode = data.sponsorCode !== undefined ? data.sponsorCode : data.sponsor_code;
        if (spName !== undefined || spCode !== undefined) {
            await tx`DELETE FROM associate_sponsor WHERE associate_id = ${targetId}`;
            await tx`
              INSERT INTO associate_sponsor (associate_id, sponsor_name, sponsor_code, sponsor_contact)
              VALUES (${targetId}, ${spName || null}, ${spCode || null}, ${data.sponsorContact || data.sponsor_contact || null})
            `;
        }

        if (existing.user_id) {
            await tx`UPDATE users SET enrollment_status = 'Completed' WHERE user_id = ${existing.user_id}`;
        }
    });

    return await adminGetAssociateEnrollmentById(targetId);
}
