import { z } from "zod";
import sql from "../db.js";
import bcrypt from "bcryptjs";
import { saveFileToVPS } from "./fileStorage.service.js";
import fs from "fs/promises";
import path from "path";
import { getStorageRoot, ensureDirExists } from "./fileStorage.service.js";
import { normalizeHumanName, isValidHumanName, calculateAge } from "../utils/validationHelper.js";

// Ensure table exists on first invocation
let tableInitialized = false;
export async function ensureTeamMembersTable(): Promise<void> {
  if (tableInitialized) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS team_members (
        id BIGSERIAL PRIMARY KEY,
        team_member_uid VARCHAR(30) UNIQUE NOT NULL,
        associate_id BIGINT NOT NULL,
        associate_name VARCHAR(150) NOT NULL,
        user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        slot_number SMALLINT CHECK (slot_number BETWEEN 1 AND 11),
        full_name VARCHAR(150) NOT NULL,
        father_husband_name VARCHAR(150),
        date_of_birth DATE,
        gender VARCHAR(15),
        aadhar_no VARCHAR(12),
        pan_no VARCHAR(10),
        mobile_no VARCHAR(15) NOT NULL,
        email_id VARCHAR(150),
        full_address TEXT,
        photo_url VARCHAR(255),
        nominee_name VARCHAR(150),
        nominee_relation VARCHAR(80),
        nominee_age_dob VARCHAR(30),
        nominee_contact_no VARCHAR(15),
        bank_name VARCHAR(150),
        branch_name VARCHAR(150),
        account_no VARCHAR(30),
        ifsc_code VARCHAR(15),
        declaration_accepted BOOLEAN NOT NULL DEFAULT false,
        applicant_signature_url VARCHAR(255),
        associate_signature_url VARCHAR(255),
        authorized_signatory_name VARCHAR(150),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    await sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL`.catch(() => {});
    await sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS slot_number SMALLINT`.catch(() => {});
    await sql`ALTER TABLE team_members DROP CONSTRAINT IF EXISTS team_members_slot_number_check`.catch(() => {});
    await sql`ALTER TABLE team_members DROP CONSTRAINT IF EXISTS chk_team_members_slot`.catch(() => {});
    await sql`ALTER TABLE team_members ADD CONSTRAINT team_members_slot_number_check CHECK (slot_number BETWEEN 1 AND 10)`.catch(() => {});
    await sql`ALTER TABLE team_members ALTER COLUMN father_husband_name DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE team_members ALTER COLUMN date_of_birth DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE team_members ALTER COLUMN gender DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE team_members ALTER COLUMN aadhar_no DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE team_members ALTER COLUMN full_address DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE team_members ALTER COLUMN bank_name DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE team_members ALTER COLUMN branch_name DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE team_members ALTER COLUMN account_no DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE team_members ALTER COLUMN ifsc_code DROP NOT NULL`.catch(() => {});
    await sql`CREATE INDEX IF NOT EXISTS idx_team_members_associate_id ON team_members (associate_id)`.catch(() => {});
    await sql`CREATE INDEX IF NOT EXISTS idx_team_members_uid ON team_members (team_member_uid)`.catch(() => {});
    await sql`CREATE INDEX IF NOT EXISTS idx_team_members_status ON team_members (status)`.catch(() => {});
    await sql`CREATE INDEX IF NOT EXISTS idx_team_members_associate_created ON team_members (associate_id, created_at DESC)`.catch(() => {});
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_team_members_assoc_slot ON team_members (associate_id, slot_number)`.catch(() => {});

    tableInitialized = true;
  } catch (err) {
    console.error("[TeamMemberService] Table initialization check:", err);
  }
}

// Zod Validation Schema
export const teamMemberSchema = z.object({
  associateId: z.coerce.number().positive("Associate ID is required"),
  associateName: z.string().min(1, "Associate Name is required"),
  fullName: z.string().min(2, "Full Name is required").max(150)
    .refine(v => isValidHumanName(v), { message: "Full Name must contain only alphabets and spaces" })
    .transform(v => normalizeHumanName(v)),
  fatherHusbandName: z.string().min(2, "Father/Husband Name is required").max(150)
    .refine(v => isValidHumanName(v), { message: "Father/Husband Name must contain only alphabets and spaces" })
    .transform(v => normalizeHumanName(v)),
  dateOfBirth: z.string().min(1, "Date of birth is required")
    .refine(v => calculateAge(v) >= 18, { message: "Team Member must be at least 18 years old" }),
  gender: z.string().refine(v => ["Male", "Female", "Other"].includes(v), { message: "Gender must be Male, Female, or Other" }),
  aadharNo: z.string().regex(/^[0-9]{12}$/, "Aadhar Number must be exactly 12 digits"),
  panNo: z.string().transform(v => (v ? v.trim().toUpperCase() : "")).optional().nullable()
    .refine(v => !v || /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(v), { message: "Invalid PAN Number format (e.g. ABCDE1234F)" }),
  mobileNo: z.string().regex(/^[0-9]{10,15}$/, "Mobile Number must be 10-15 digits"),
  emailId: z.string().email("Invalid email address").optional().nullable().or(z.literal("")),
  fullAddress: z.string().min(5, "Full Address must be at least 5 characters"),
  
  nomineeName: z.string().optional().nullable()
    .refine(v => !v || isValidHumanName(v), { message: "Nominee Name must contain only alphabets and spaces" })
    .transform(v => (v ? normalizeHumanName(v) : v)),
  nomineeRelation: z.string().optional().nullable(),
  nomineeAgeDob: z.string().optional().nullable(),
  nomineeContactNo: z.string().optional().nullable(),

  bankName: z.string().min(2, "Bank Name is required"),
  branchName: z.string().min(2, "Branch Name is required"),
  accountNo: z.string().min(4, "Account Number must be at least 4 digits").max(30),
  ifscCode: z.string().transform(v => (v ? v.trim().toUpperCase() : "")).pipe(
    z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Invalid IFSC Code format (e.g. SBIN0001234)")
  ),

  declarationAccepted: z.preprocess(
    (val) => val === true || val === "true" || val === 1 || val === "1",
    z.boolean().refine(val => val === true, "You must accept the Declaration before submitting")
  ),
  applicantSignature: z.string().optional().nullable(),
  associateSignature: z.string().optional().nullable()
});

export type TeamMemberInput = z.infer<typeof teamMemberSchema>;

/**
 * Masking utilities for PII data protection
 */
export function maskAadhar(aadhar: string | null | undefined): string {
  if (!aadhar) return "";
  const cleaned = String(aadhar).replace(/\D/g, "");
  if (cleaned.length < 4) return cleaned;
  return `XXXX-XXXX-${cleaned.slice(-4)}`;
}

export function maskAccountNo(account: string | null | undefined): string {
  if (!account) return "";
  const str = String(account);
  if (str.length <= 4) return str;
  return `${"X".repeat(str.length - 4)}${str.slice(-4)}`;
}

/**
 * Save base64 data URL signature image directly to storage
 */
export async function saveSignatureDataUrl(
  dataUrl: string,
  associateId: number | string,
  sigType: "applicant" | "associate"
): Promise<string | null> {
  if (!dataUrl || !dataUrl.startsWith("data:image/")) {
    return null;
  }
  try {
    const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) return null;
    const extension = matches[1].includes("jpeg") || matches[1].includes("jpg") ? "jpg" : "png";
    const buffer = Buffer.from(matches[2], "base64");

    const rootDir = getStorageRoot();
    const dirPath = path.join(rootDir, "team-members", String(associateId), "signatures");
    await ensureDirExists(dirPath);

    const fileName = `sig-${sigType}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${extension}`;
    const filePath = path.join(dirPath, fileName);
    await fs.writeFile(filePath, buffer);

    return `/uploads/team-members/${associateId}/signatures/${fileName}`;
  } catch (err) {
    console.error("[TeamMemberService] Failed to save signature:", err);
    return null;
  }
}

/**
 * Auto-generate UID in format MMR-TM-XXXXX (e.g. MMR-TM-00001)
 */
async function generateTeamMemberUid(tx: any): Promise<string> {
  const [res] = await tx`
    SELECT COALESCE(MAX(
      CASE
        WHEN team_member_uid ~* '^MMR-TM-[0-9]+$' THEN SUBSTRING(team_member_uid FROM 8)::integer
        WHEN team_member_uid ~* '^MMR-TM-[0-9]+-[0-9]+$' THEN SUBSTRING(team_member_uid FROM 13)::integer
        ELSE id END
    ), 0) + 1 AS next_seq
    FROM team_members
  `;
  const nextSeq = res?.next_seq || 1;
  return `MMR-TM-${String(nextSeq).padStart(5, "0")}`;
}

/**
 * 1. Prefill Endpoint
 * Returns known associate information to auto-fill the form
 */
export async function getAssociatePrefill(associateId: number | string) {
  await ensureTeamMembersTable();
  const id = Number(associateId);

  // 1. Fetch user master record
  const [user] = await sql`
    SELECT user_id, full_name, mobile_no, email, member_id, user_type
    FROM users 
    WHERE user_id = ${id}
    LIMIT 1
  `;

  let associateName = user?.full_name || "";
  let mobileNo = user?.mobile_no || "";
  let emailId = user?.email || "";
  let bankName = "";
  let branchName = "";
  let accountNo = "";
  let ifscCode = "";

  // 2. Look for bank details in user_bank_details or associate_bank_details
  const [userBank] = await sql`
    SELECT bank_name, branch_name, account_no, ifsc_code
    FROM user_bank_details
    WHERE user_id = ${id}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (userBank) {
    bankName = userBank.bank_name || "";
    branchName = userBank.branch_name || "";
    accountNo = userBank.account_no || "";
    ifscCode = userBank.ifsc_code || "";
  } else {
    // Check associate_enrollment / associate_bank_details
    const [assocEnroll] = await sql`
      SELECT ae.id, ae.full_name, ae.contact_no_1, ae.email,
             abd.bank_name, abd.branch_name, abd.account_no, abd.ifsc_code
      FROM associate_enrollment ae
      LEFT JOIN associate_bank_details abd ON ae.id = abd.associate_id
      WHERE ae.user_id = ${id} OR ae.contact_no_1 = ${mobileNo}
      ORDER BY ae.created_at DESC
      LIMIT 1
    `;
    if (assocEnroll) {
      if (!associateName) associateName = assocEnroll.full_name;
      if (!mobileNo) mobileNo = assocEnroll.contact_no_1;
      if (!emailId) emailId = assocEnroll.email;
      bankName = assocEnroll.bank_name || "";
      branchName = assocEnroll.branch_name || "";
      accountNo = assocEnroll.account_no || "";
      ifscCode = assocEnroll.ifsc_code || "";
    }
  }

  return {
    associateId: id,
    associateName: associateName || `Associate #${id}`,
    mobileNo,
    emailId,
    bankName,
    branchName,
    accountNo,
    ifscCode,
    memberId: user?.member_id || ""
  };
}

/**
 * 2. Create Team Member Enrollment
 */
export async function createTeamMemberRecord(
  data: TeamMemberInput,
  photoUrl: string | null,
  applicantSigUrl: string | null,
  associateSigUrl: string | null
) {
  await ensureTeamMembersTable();

  // If signature data URLs are supplied in the body, save them to storage
  if (!applicantSigUrl && data.applicantSignature) {
    applicantSigUrl = await saveSignatureDataUrl(data.applicantSignature, data.associateId, "applicant");
  }
  if (!associateSigUrl && data.associateSignature) {
    associateSigUrl = await saveSignatureDataUrl(data.associateSignature, data.associateId, "associate");
  }

  let createdRecord: any = null;

  await sql.begin(async (tx: any) => {
    // Concurrency lock for slot assignment on this associate
    await tx`SELECT pg_advisory_xact_lock(hashtext('associate-team-slot-' || ${data.associateId}))`;

    // 1. Verify associate exists in users table
    const [assocUser] = await tx`
      SELECT user_id, full_name, user_type, account_status
      FROM users
      WHERE user_id = ${data.associateId}
      LIMIT 1
    `;
    if (!assocUser) {
      throw new Error(`Associate with ID ${data.associateId} not found`);
    }

    // 2. Check occupied slots for this associate (ignore rejected)
    const existingMembers = await tx`
      SELECT id, slot_number, status, user_id, team_member_uid
      FROM team_members
      WHERE associate_id = ${data.associateId}
        AND status <> 'rejected'
      ORDER BY slot_number ASC
    `;
    const occupiedSlots = new Set(existingMembers.map((m: any) => Number(m.slot_number)).filter(Boolean));

    // 3. Match or lookup user master record in users table
    const cleanMobile = String(data.mobileNo || "").replace(/[^0-9]/g, "");
    const cleanAadhar = String(data.aadharNo || "").replace(/[^0-9]/g, "");
    const cleanEmail = data.emailId ? String(data.emailId).trim().toLowerCase() : null;
    const explicitUserId = data.userId || data.user_id ? Number(data.userId || data.user_id) : null;

    let userId: number | null = null;
    let existingUser: any = null;

    if (explicitUserId) {
      const [u] = await tx`
        SELECT user_id, user_type, member_id, sponsor_user_id
        FROM users
        WHERE user_id = ${explicitUserId}
        LIMIT 1
      `;
      if (u) existingUser = u;
    }

    if (!existingUser) {
      const [u] = await tx`
        SELECT user_id, user_type, member_id, sponsor_user_id
        FROM users
        WHERE mobile_no = ${cleanMobile}
           OR (aadhar_number = ${cleanAadhar} AND ${Boolean(cleanAadhar)})
           OR (email = ${cleanEmail} AND ${Boolean(cleanEmail)})
        LIMIT 1
      `;
      if (u) existingUser = u;
    }

    let existingTm: any = null;
    if (existingUser) {
      if (String(existingUser.user_type || '').toLowerCase() === 'customer') {
        throw new Error("Customer accounts cannot be converted to Team Members.");
      }
      if (existingUser.sponsor_user_id && Number(existingUser.sponsor_user_id) !== Number(data.associateId)) {
        throw new Error("Unauthorized: This user account is associated with a different sponsor.");
      }
      userId = existingUser.user_id;
      existingTm = existingMembers.find((m: any) => Number(m.user_id) === Number(userId));
      if (!existingUser.sponsor_user_id) {
        await tx`
          UPDATE users
          SET sponsor_user_id = ${data.associateId}, updated_at = NOW()
          WHERE user_id = ${userId}
        `;
      }
      if (data.panNo || cleanAadhar) {
        await tx`
          UPDATE users
          SET
            pan_number = COALESCE(${data.panNo || null}, pan_number),
            aadhar_number = COALESCE(${cleanAadhar || null}, aadhar_number),
            updated_at = NOW()
          WHERE user_id = ${userId}
        `;
      }
    }

    // Determine assigned slot (1 to 10 direct members, 11 total with Team Lead)
    let assignedSlot: number | null = existingTm ? Number(existingTm.slot_number) : null;
    if (!assignedSlot && data.slotNumber && Number(data.slotNumber) >= 1 && Number(data.slotNumber) <= 10 && !occupiedSlots.has(Number(data.slotNumber))) {
      assignedSlot = Number(data.slotNumber);
    }
    if (!assignedSlot) {
      for (let s = 1; s <= 10; s++) {
        if (!occupiedSlots.has(s)) {
          assignedSlot = s;
          break;
        }
      }
    }

    if (!assignedSlot || (occupiedSlots.size >= 10 && !existingTm)) {
      throw new Error("This Associate (Team Lead) has reached the maximum limit of 10 direct Team Members (11 total team size). No available slots.");
    }

    // Generate unique Team Member ID if not already present
    const uid = existingTm?.team_member_uid || existingUser?.member_id || await generateTeamMemberUid(tx);

    if (!existingUser) {
      const [newUser] = await tx`
        INSERT INTO users (
          member_id, user_type, full_name, mobile_no, email,
          pan_number, aadhar_number, sponsor_user_id, account_status, is_active, registered_at
        ) VALUES (
          ${uid}, 'Team Member', ${data.fullName.trim()}, ${cleanMobile}, ${cleanEmail},
          ${data.panNo || null}, ${cleanAadhar}, ${data.associateId}, 'Pending', true, NOW()
        )
        ON CONFLICT DO NOTHING
        RETURNING user_id
      `;
      if (newUser) {
        userId = newUser.user_id;
      }
    }

    // 4. Upsert into team_members with slot_number and user_id
    let inserted: any = null;
    if (existingTm) {
      const [updatedTm] = await tx`
        UPDATE team_members
        SET
          slot_number = ${assignedSlot},
          full_name = ${data.fullName.trim()},
          father_husband_name = ${data.fatherHusbandName.trim()},
          date_of_birth = ${data.dateOfBirth},
          gender = ${data.gender},
          aadhar_no = ${cleanAadhar},
          pan_no = ${data.panNo || null},
          mobile_no = ${cleanMobile},
          email_id = ${cleanEmail},
          full_address = ${data.fullAddress.trim()},
          photo_url = COALESCE(${photoUrl}, photo_url),
          nominee_name = ${data.nomineeName || null},
          nominee_relation = ${data.nomineeRelation || null},
          nominee_age_dob = ${data.nomineeAgeDob || null},
          nominee_contact_no = ${data.nomineeContactNo || null},
          bank_name = ${data.bankName.trim()},
          branch_name = ${data.branchName.trim()},
          account_no = ${data.accountNo.trim()},
          ifsc_code = ${data.ifscCode.trim().toUpperCase()},
          declaration_accepted = ${data.declarationAccepted},
          applicant_signature_url = COALESCE(${applicantSigUrl}, applicant_signature_url),
          associate_signature_url = COALESCE(${associateSigUrl}, associate_signature_url),
          status = 'pending',
          updated_at = NOW()
        WHERE id = ${existingTm.id}
        RETURNING *
      `;
      inserted = updatedTm;
    } else {
      const [newTm] = await tx`
        INSERT INTO team_members (
          team_member_uid,
          associate_id,
          associate_name,
          user_id,
          slot_number,
          full_name,
          father_husband_name,
          date_of_birth,
          gender,
          aadhar_no,
          pan_no,
          mobile_no,
          email_id,
          full_address,
          photo_url,
          nominee_name,
          nominee_relation,
          nominee_age_dob,
          nominee_contact_no,
          bank_name,
          branch_name,
          account_no,
          ifsc_code,
          declaration_accepted,
          applicant_signature_url,
          associate_signature_url,
          status,
          created_at,
          updated_at
        ) VALUES (
          ${uid},
          ${data.associateId},
          ${data.associateName || assocUser.full_name},
          ${userId},
          ${assignedSlot},
          ${data.fullName.trim()},
          ${data.fatherHusbandName.trim()},
          ${data.dateOfBirth},
          ${data.gender},
          ${cleanAadhar},
          ${data.panNo || null},
          ${cleanMobile},
          ${cleanEmail},
          ${data.fullAddress.trim()},
          ${photoUrl},
          ${data.nomineeName || null},
          ${data.nomineeRelation || null},
          ${data.nomineeAgeDob || null},
          ${data.nomineeContactNo || null},
          ${data.bankName.trim()},
          ${data.branchName.trim()},
          ${data.accountNo.trim()},
          ${data.ifscCode.trim().toUpperCase()},
          ${data.declarationAccepted},
          ${applicantSigUrl},
          ${associateSigUrl},
          'pending',
          NOW(),
          NOW()
        )
        RETURNING *
      `;
      inserted = newTm;
    }

    // 5. Sync user secondary tables for profile consistency
    if (userId) {
      // User Address
      await tx`
        INSERT INTO user_addresses (user_id, address_line1, city, state, pincode, address_type, is_primary)
        VALUES (${userId}, ${data.fullAddress.trim()}, 'Lucknow', 'Uttar Pradesh', '226001', 'Permanent', true)
        ON CONFLICT (user_id) DO UPDATE
        SET address_line1 = EXCLUDED.address_line1, updated_at = NOW()
      `.catch(() => {});

      // User Bank
      await tx`
        INSERT INTO user_bank_details (user_id, bank_name, branch_name, account_number, ifsc_code, is_primary)
        VALUES (${userId}, ${data.bankName.trim()}, ${data.branchName.trim()}, ${data.accountNo.trim()}, ${data.ifscCode.trim().toUpperCase()}, true)
        ON CONFLICT (user_id) DO UPDATE
        SET bank_name = EXCLUDED.bank_name, branch_name = EXCLUDED.branch_name,
            account_number = EXCLUDED.account_number, ifsc_code = EXCLUDED.ifsc_code, updated_at = NOW()
      `.catch(() => {});

      // User Nominee
      if (data.nomineeName) {
        await tx`
          INSERT INTO user_nominees (user_id, nominee_name, relationship, nominee_age, nominee_phone)
          VALUES (${userId}, ${data.nomineeName}, ${data.nomineeRelation || 'Nominee'}, ${data.nomineeAgeDob ? String(data.nomineeAgeDob) : null}, ${data.nomineeContactNo || null})
          ON CONFLICT (user_id) DO UPDATE
          SET nominee_name = EXCLUDED.nominee_name, relationship = EXCLUDED.relationship, updated_at = NOW()
        `.catch(() => {});
      }
    }

    createdRecord = inserted;
  });

  return {
    ...createdRecord,
    aadhar_no_masked: maskAadhar(createdRecord.aadhar_no),
    account_no_masked: maskAccountNo(createdRecord.account_no)
  };
}

/**
 * 3. List Team Members Scoped by Associate
 */
export async function getTeamMembersByAssociate(
  associateId: number | string,
  options: { search?: string; status?: string; page?: number; limit?: number } = {}
) {
  await ensureTeamMembersTable();
  const id = Number(associateId);
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
  const offset = (page - 1) * limit;
  const searchPattern = options.search ? `%${options.search.trim()}%` : null;
  const statusFilter = options.status && options.status !== "all" ? options.status.toLowerCase() : null;

  let countRows;
  let rows;

  if (searchPattern && statusFilter) {
    countRows = await sql`
      SELECT COUNT(*)::integer AS total
      FROM team_members
      WHERE associate_id = ${id}
        AND status = ${statusFilter}
        AND (
          full_name ILIKE ${searchPattern}
          OR team_member_uid ILIKE ${searchPattern}
          OR mobile_no ILIKE ${searchPattern}
          OR aadhar_no ILIKE ${searchPattern}
        )
    `;
    rows = await sql`
      SELECT *
      FROM team_members
      WHERE associate_id = ${id}
        AND status = ${statusFilter}
        AND (
          full_name ILIKE ${searchPattern}
          OR team_member_uid ILIKE ${searchPattern}
          OR mobile_no ILIKE ${searchPattern}
          OR aadhar_no ILIKE ${searchPattern}
        )
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (searchPattern) {
    countRows = await sql`
      SELECT COUNT(*)::integer AS total
      FROM team_members
      WHERE associate_id = ${id}
        AND (
          full_name ILIKE ${searchPattern}
          OR team_member_uid ILIKE ${searchPattern}
          OR mobile_no ILIKE ${searchPattern}
          OR aadhar_no ILIKE ${searchPattern}
        )
    `;
    rows = await sql`
      SELECT *
      FROM team_members
      WHERE associate_id = ${id}
        AND (
          full_name ILIKE ${searchPattern}
          OR team_member_uid ILIKE ${searchPattern}
          OR mobile_no ILIKE ${searchPattern}
          OR aadhar_no ILIKE ${searchPattern}
        )
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (statusFilter) {
    countRows = await sql`
      SELECT COUNT(*)::integer AS total
      FROM team_members
      WHERE associate_id = ${id} AND status = ${statusFilter}
    `;
    rows = await sql`
      SELECT *
      FROM team_members
      WHERE associate_id = ${id} AND status = ${statusFilter}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    countRows = await sql`
      SELECT COUNT(*)::integer AS total
      FROM team_members
      WHERE associate_id = ${id}
    `;
    rows = await sql`
      SELECT *
      FROM team_members
      WHERE associate_id = ${id}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  const total = countRows[0]?.total || 0;

  const sanitizedRows = rows.map(r => ({
    ...r,
    aadhar_no_masked: maskAadhar(r.aadhar_no),
    account_no_masked: maskAccountNo(r.account_no),
    aadhar_no: maskAadhar(r.aadhar_no) // Mask by default in list view
  }));

  return {
    items: sanitizedRows,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
}

/**
 * 4. Get Single Team Member Record
 */
export async function getTeamMemberById(id: number | string, authUserId?: number | string, isAdmin = false) {
  await ensureTeamMembersTable();
  let rows;
  if (String(id).toLowerCase() === "me") {
    if (!authUserId) return null;
    rows = await sql`SELECT * FROM team_members WHERE user_id = ${Number(authUserId)} LIMIT 1`;
  } else {
    const numId = Number(id);
    if (isNaN(numId)) {
      // Match by team_member_uid
      rows = await sql`SELECT * FROM team_members WHERE team_member_uid = ${String(id)} LIMIT 1`;
    } else {
      rows = await sql`SELECT * FROM team_members WHERE id = ${numId} OR team_member_uid = ${String(id)} LIMIT 1`;
    }
  }

  if (!rows || rows.length === 0) return null;
  const record = rows[0];

  // Enforce scoping: accessible by admin, the owner associate, or the team member themselves
  if (!isAdmin && authUserId) {
    const uid = Number(authUserId);
    const isOwnerAssociate = Number(record.associate_id) === uid;
    const isSelfMember = Number(record.user_id) === uid;
    if (!isOwnerAssociate && !isSelfMember) {
      throw new Error("Unauthorized access to this team member record");
    }
  }

  return {
    ...record,
    aadhar_no_masked: maskAadhar(record.aadhar_no),
    account_no_masked: maskAccountNo(record.account_no)
  };
}

/**
 * 5. Update Team Member (Draft / Pending only)
 */
export async function updateTeamMemberRecord(
  id: number | string,
  data: Partial<TeamMemberInput>,
  photoUrl: string | null,
  applicantSigUrl: string | null,
  associateSigUrl: string | null,
  associateId?: number | string,
  isAdmin = false
) {
  await ensureTeamMembersTable();
  const numId = Number(id);

  const existing = await getTeamMemberById(numId, associateId, isAdmin);
  if (!existing) {
    throw new Error("Team member not found");
  }

  if (existing.status !== "pending" && !isAdmin) {
    throw new Error("Only pending team member records can be updated");
  }

  if (!applicantSigUrl && data.applicantSignature && data.applicantSignature.startsWith("data:image/")) {
    applicantSigUrl = await saveSignatureDataUrl(data.applicantSignature, existing.associate_id, "applicant");
  }
  if (!associateSigUrl && data.associateSignature && data.associateSignature.startsWith("data:image/")) {
    associateSigUrl = await saveSignatureDataUrl(data.associateSignature, existing.associate_id, "associate");
  }

  const [updated] = await sql`
    UPDATE team_members
    SET
      full_name = COALESCE(${data.fullName || null}, full_name),
      father_husband_name = COALESCE(${data.fatherHusbandName || null}, father_husband_name),
      date_of_birth = COALESCE(${data.dateOfBirth || null}, date_of_birth),
      gender = COALESCE(${data.gender || null}, gender),
      aadhar_no = COALESCE(${data.aadharNo || null}, aadhar_no),
      pan_no = COALESCE(${data.panNo || null}, pan_no),
      mobile_no = COALESCE(${data.mobileNo || null}, mobile_no),
      email_id = COALESCE(${data.emailId || null}, email_id),
      full_address = COALESCE(${data.fullAddress || null}, full_address),
      photo_url = COALESCE(${photoUrl}, photo_url),
      nominee_name = COALESCE(${data.nomineeName || null}, nominee_name),
      nominee_relation = COALESCE(${data.nomineeRelation || null}, nominee_relation),
      nominee_age_dob = COALESCE(${data.nomineeAgeDob || null}, nominee_age_dob),
      nominee_contact_no = COALESCE(${data.nomineeContactNo || null}, nominee_contact_no),
      bank_name = COALESCE(${data.bankName || null}, bank_name),
      branch_name = COALESCE(${data.branchName || null}, branch_name),
      account_no = COALESCE(${data.accountNo || null}, account_no),
      ifsc_code = COALESCE(${data.ifscCode || null}, ifsc_code),
      applicant_signature_url = COALESCE(${applicantSigUrl}, applicant_signature_url),
      associate_signature_url = COALESCE(${associateSigUrl}, associate_signature_url),
      updated_at = NOW()
    WHERE id = ${existing.id}
    RETURNING *
  `;

  return {
    ...updated,
    aadhar_no_masked: maskAadhar(updated.aadhar_no),
    account_no_masked: maskAccountNo(updated.account_no)
  };
}

/**
 * 6. Status Update & Users Account Sync (Approve / Reject / Inactivate)
 */
export async function updateTeamMemberStatus(
  id: number | string,
  status: string,
  authorizedSignatoryName?: string | null
) {
  await ensureTeamMembersTable();
  const numId = Number(id);
  const normalizedStatus = String(status || "").toLowerCase().trim();
  let result: any = null;

  await sql.begin(async (tx: any) => {
    // 1. Fetch current team_members record
    let rows = isNaN(numId)
      ? await tx`SELECT * FROM team_members WHERE team_member_uid = ${String(id)} LIMIT 1 FOR UPDATE`
      : await tx`SELECT * FROM team_members WHERE id = ${numId} OR team_member_uid = ${String(id)} LIMIT 1 FOR UPDATE`;
    if (!rows || rows.length === 0) {
      throw new Error("Team member not found");
    }
    const current = rows[0];

    // 2. Update team_members status
    const [updated] = await tx`
      UPDATE team_members
      SET
        status = ${normalizedStatus},
        authorized_signatory_name = COALESCE(${authorizedSignatoryName || null}, authorized_signatory_name),
        updated_at = NOW()
      WHERE id = ${current.id}
      RETURNING *
    `;

    // 3. Map team member status to users.account_status
    let targetAccountStatus = "Pending";
    let targetIsActive = true;
    if (["approved", "active"].includes(normalizedStatus)) {
      targetAccountStatus = "Approved";
      targetIsActive = true;
    } else if (normalizedStatus === "rejected") {
      targetAccountStatus = "Rejected";
      targetIsActive = false;
    } else if (normalizedStatus === "inactive" || normalizedStatus === "blocked") {
      targetAccountStatus = "Inactive";
      targetIsActive = false;
    } else {
      targetAccountStatus = "Pending";
      targetIsActive = true;
    }

    // 4. Sync linked users master account
    let userId = current.user_id;
    const cleanMobile = String(current.mobile_no || "").replace(/[^0-9]/g, "");
    const cleanAadhar = String(current.aadhar_no || "").replace(/[^0-9]/g, "");
    const cleanEmail = current.email_id ? String(current.email_id).trim().toLowerCase() : null;

    if (!userId) {
      const [existingUser] = await tx`
        SELECT user_id, user_type, account_status, sponsor_user_id
        FROM users
        WHERE mobile_no = ${cleanMobile}
           OR (aadhar_number = ${cleanAadhar} AND ${Boolean(cleanAadhar)})
           OR (email = ${cleanEmail} AND ${Boolean(cleanEmail)})
        LIMIT 1
      `;
      if (existingUser) {
        userId = existingUser.user_id;
      }
    }

    if (userId) {
      await tx`
        UPDATE users
        SET
          user_type = COALESCE(user_type, 'Team Member'),
          sponsor_user_id = COALESCE(sponsor_user_id, ${current.associate_id}),
          account_status = ${targetAccountStatus},
          is_active = ${targetIsActive},
          member_id = COALESCE(member_id, ${current.team_member_uid}),
          updated_at = NOW()
        WHERE user_id = ${userId}
      `;
      if (current.user_id !== userId) {
        await tx`UPDATE team_members SET user_id = ${userId} WHERE id = ${current.id}`;
        updated.user_id = userId;
      }
    } else if (["approved", "active"].includes(normalizedStatus)) {
      const [newUser] = await tx`
        INSERT INTO users (
          member_id, user_type, full_name, mobile_no, email,
          pan_number, aadhar_number, sponsor_user_id, account_status, is_active, registered_at
        ) VALUES (
          ${current.team_member_uid}, 'Team Member', ${current.full_name}, ${cleanMobile}, ${cleanEmail},
          ${current.pan_no || null}, ${cleanAadhar}, ${current.associate_id}, ${targetAccountStatus}, ${targetIsActive}, NOW()
        )
        ON CONFLICT (mobile_no) DO UPDATE
        SET account_status = ${targetAccountStatus}, is_active = ${targetIsActive}, user_type = 'Team Member', sponsor_user_id = ${current.associate_id}
        RETURNING user_id
      `;
      if (newUser) {
        userId = newUser.user_id;
        await tx`UPDATE team_members SET user_id = ${userId} WHERE id = ${current.id}`;
        updated.user_id = userId;
      }
    }

    result = updated;
  });

  return {
    ...result,
    aadhar_no_masked: maskAadhar(result.aadhar_no),
    account_no_masked: maskAccountNo(result.account_no)
  };
}

/**
 * 7. Fast Team Member Registration (From Associate Dashboard / My Team Popup)
 */
export async function registerTeamMemberQuick(associateId: number, data: any) {
  await ensureTeamMembersTable();
  const { fullName, email, mobileNo, password } = data || {};

  if (!fullName || !email || !mobileNo || !password) {
    throw new Error("Full Name, Email, Mobile Number, and Password are all required.");
  }

  if (!isValidHumanName(fullName)) {
    throw new Error("Full Name must contain only alphabets and spaces.");
  }

  const cleanMobile = String(mobileNo).replace(/\D/g, "");
  if (cleanMobile.length < 10) {
    throw new Error("Please enter a valid 10-digit mobile number.");
  }

  const cleanEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error("Invalid email address format.");
  }

  if (String(password).length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }

  let createdResult: any = null;
  await sql.begin(async (tx: any) => {
    // Concurrency lock for slot assignment on this associate
    await tx`SELECT pg_advisory_xact_lock(hashtext('associate-team-slot-' || ${associateId}))`;

    // 1. Verify associate exists in users table
    const [assocUser] = await tx`
      SELECT user_id, full_name, user_type, member_id, invitation_code, account_status
      FROM users
      WHERE user_id = ${associateId}
      LIMIT 1
    `;
    if (!assocUser) {
      throw new Error(`Associate with ID ${associateId} not found`);
    }

    // 2. Check occupied slots (1 to 11)
    const existingMembers = await tx`
      SELECT id, slot_number, status
      FROM team_members
      WHERE associate_id = ${associateId}
        AND status <> 'rejected'
      ORDER BY slot_number ASC
    `;
    const occupiedSlots = new Set(existingMembers.map((m: any) => Number(m.slot_number)).filter(Boolean));

    let assignedSlot: number | null = null;
    const requestedSlot = Number(data?.slotNumber || data?.slot_number || 0);
    if (requestedSlot >= 1 && requestedSlot <= 10) {
      if (occupiedSlots.has(requestedSlot)) {
        throw new Error(`Slot #${requestedSlot} is already occupied. Please select an available slot.`);
      }
      assignedSlot = requestedSlot;
    } else {
      for (let s = 1; s <= 10; s++) {
        if (!occupiedSlots.has(s)) {
          assignedSlot = s;
          break;
        }
      }
    }
    if (!assignedSlot || occupiedSlots.size >= 10) {
      throw new Error("This Associate (Team Lead) has reached the maximum limit of 10 direct Team Members (11 total team size). No available slots.");
    }

    // 3. Duplicate checks
    const [dupMobile] = await tx`
      SELECT user_id FROM users 
      WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile.slice(-10)}
    `;
    const [dupInvestorMobile] = await tx`
      SELECT id FROM investor_users 
      WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${cleanMobile.slice(-10)} 
        AND (deleted_at IS NULL) LIMIT 1
    `;
    if (dupMobile || dupInvestorMobile) {
      throw new Error("Mobile number is already registered in the system.");
    }

    const [dupEmail] = await tx`SELECT user_id FROM users WHERE LOWER(email) = ${cleanEmail}`;
    const [dupInvestorEmail] = await tx`SELECT id FROM investor_users WHERE LOWER(email) = ${cleanEmail} AND (deleted_at IS NULL) LIMIT 1`;
    if (dupEmail || dupInvestorEmail) {
      throw new Error("Email address is already registered in the system.");
    }

    // 4. Generate unique Team Member ID
    const uid = await generateTeamMemberUid(tx);
    const passwordHash = await bcrypt.hash(password, 12);
    const cleanName = normalizeHumanName(fullName);

    // 5. Insert into users
    const [createdUser] = await tx`
      INSERT INTO users (
        member_id, user_type, full_name, mobile_no, email, password_hash,
        sponsor_user_id, account_status, is_active, email_verified, is_otp_verified,
        registered_at, updated_at
      ) VALUES (
        ${uid}, 'Team Member', ${cleanName}, ${cleanMobile}, ${cleanEmail}, ${passwordHash},
        ${associateId}, 'Pending', true, true, true,
        NOW(), NOW()
      )
      RETURNING user_id, member_id, user_type, full_name, email, mobile_no, account_status, registered_at
    `;

    // 6. Insert into team_members
    const [insertedMember] = await tx`
      INSERT INTO team_members (
        team_member_uid, associate_id, associate_name, user_id, slot_number,
        full_name, mobile_no, email_id, status, created_at, updated_at
      ) VALUES (
        ${uid}, ${associateId}, ${assocUser.full_name}, ${createdUser.user_id}, ${assignedSlot},
        ${cleanName}, ${cleanMobile}, ${cleanEmail}, 'pending', NOW(), NOW()
      )
      RETURNING id, team_member_uid, associate_id, associate_name, user_id, slot_number, full_name, mobile_no, email_id, status, created_at
    `;

    try {
      await tx`
        INSERT INTO user_wallets (user_id, user_role, available_balance, pending_withdrawal_balance, total_added_fund, total_withdrawn, total_commission)
        VALUES (${createdUser.user_id}, 'Team Member', 0, 0, 0, 0, 0)
        ON CONFLICT (user_id) DO NOTHING
      `;
    } catch (_) {}

    try {
      await tx`
        INSERT INTO referral_registrations (sponsor_user_id, referred_user_id, status, approved_at)
        VALUES (${associateId}, ${createdUser.user_id}, 'Pending', NULL)
        ON CONFLICT (referred_user_id) DO NOTHING
      `;
    } catch (_) {}

    createdResult = {
      user_id: createdUser.user_id,
      member_id: createdUser.member_id,
      team_member_uid: insertedMember.team_member_uid,
      full_name: createdUser.full_name,
      email: createdUser.email,
      mobile_no: createdUser.mobile_no,
      user_type: createdUser.user_type,
      slot_number: assignedSlot,
      status: insertedMember.status,
      account_status: createdUser.account_status,
      sponsor_user_id: associateId,
      sponsor_name: assocUser.full_name,
      sponsor_member_id: assocUser.member_id || `ASSOC${associateId}`
    };
  });

  return createdResult;
}


