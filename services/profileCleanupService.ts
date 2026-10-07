import sql from "../db.js";
import { deleteFileFromStorage } from "./fileStorage.service.js";

export interface AdminActor {
  admin_id?: number;
  id?: number;
  full_name?: string;
  username?: string;
}

export interface CleanupResult {
  success: boolean;
  message: string;
  data: any;
}

/**
 * Safely clean up a list of collected physical files without breaking if a file is missing.
 */
export async function cleanupPhysicalFiles(
  fileUrls: string[] = [], 
  fileObjects: Array<{ url: string; publicId?: string }> = []
): Promise<{ deletedCount: number; missingCount: number; warnings: string[] }> {
  const allTargets: Array<{ url: string; publicId?: string }> = [];
  const seen = new Set<string>();

  for (const url of fileUrls) {
    if (url && typeof url === "string" && url.trim() && !seen.has(url.trim())) {
      seen.add(url.trim());
      allTargets.push({ url: url.trim(), publicId: "" });
    }
  }

  for (const obj of fileObjects) {
    const key = (obj.url || "") + "::" + (obj.publicId || "");
    if ((obj.url || obj.publicId) && !seen.has(key)) {
      seen.add(key);
      allTargets.push({ url: obj.url || "", publicId: obj.publicId || "" });
    }
  }

  let deletedCount = 0;
  let missingCount = 0;
  const warnings: string[] = [];

  for (const target of allTargets) {
    try {
      const ok = await deleteFileFromStorage(target.url, target.publicId || "");
      if (ok) {
        deletedCount++;
      } else {
        missingCount++;
      }
    } catch (err: any) {
      missingCount++;
      warnings.push(`File cleanup skipped for ${target.url || target.publicId}: ${err.message}`);
      console.warn(`[ProfileCleanupService] File delete warning:`, err.message);
    }
  }

  return { deletedCount, missingCount, warnings };
}

/**
 * Permanently Delete an Associate Profile & ALL Exclusive Profile Data
 */
export async function deleteAssociateProfile(
  associateId: number | string, 
  adminActor: AdminActor = { admin_id: 1, full_name: "Admin" }
): Promise<CleanupResult> {
  const rawId = String(associateId || "").trim();
  if (!rawId) {
    const err: any = new Error("Associate ID is required");
    err.statusCode = 400;
    throw err;
  }

  const numId = !isNaN(Number(rawId)) ? Number(rawId) : 0;

  // 1. Resolve Target User
  const [targetUser] = await sql`
    SELECT user_id, member_id, full_name, email, mobile_no, pan_number, aadhar_number, user_type
    FROM users
    WHERE (user_id = ${numId} OR member_id = ${rawId})
      AND LOWER(user_type::text) = 'associate'
    LIMIT 1
  `;

  // 2. Resolve Any Associated Enrollment Record (by user_id, member_id, phone, PAN)
  const uid = targetUser?.user_id || 0;
  const memberId = targetUser?.member_id || rawId;
  const mobile = targetUser?.mobile_no ? String(targetUser.mobile_no).trim() : null;
  const pan = targetUser?.pan_number ? String(targetUser.pan_number).trim().toUpperCase() : null;
  const aadhar = targetUser?.aadhar_number ? String(targetUser.aadhar_number).replace(/[\s-]/g, "").trim() : null;
  const email = targetUser?.email ? String(targetUser.email).trim().toLowerCase() : null;

  const enrollments = await sql`
    SELECT id, user_id, member_id, full_name, applicant_photo_path, signature_path, print_pdf_path,
           contact_no_1, pan_no, aadhar_no, email
    FROM associate_enrollment
    WHERE id = ${rawId}
       OR (${uid > 0} AND user_id = ${uid})
       OR (${Boolean(memberId)} AND member_id = ${memberId})
       OR (${Boolean(mobile)} AND contact_no_1 = ${mobile})
       OR (${Boolean(pan)} AND UPPER(pan_no) = ${pan})
       OR (${Boolean(aadhar)} AND aadhar_no = ${aadhar})
       OR (${Boolean(email)} AND LOWER(email) = ${email})
  `;

  if (!targetUser && (!enrollments || enrollments.length === 0)) {
    const err: any = new Error("Associate not found");
    err.statusCode = 404;
    throw err;
  }

  const resolvedName = targetUser?.full_name || enrollments[0]?.full_name || "Associate";
  const resolvedMemberId = targetUser?.member_id || enrollments[0]?.member_id || enrollments[0]?.id || rawId;
  const enrollmentIds = enrollments.map((e: any) => e.id).filter(Boolean);

  // 3. Collect ALL Physical File References (Before DB modifications)
  const filesToClean: string[] = [];
  const fileObjectsToClean: Array<{ url: string; publicId?: string }> = [];

  for (const e of enrollments) {
    if (e.applicant_photo_path) filesToClean.push(e.applicant_photo_path);
    if (e.signature_path) filesToClean.push(e.signature_path);
    if (e.print_pdf_path) filesToClean.push(e.print_pdf_path);
  }

  if (enrollmentIds.length > 0) {
    const nomineePhotos = await sql`
      SELECT photo_path FROM associate_nominee 
      WHERE associate_id IN ${sql(enrollmentIds)} AND photo_path IS NOT NULL
    `;
    nomineePhotos.forEach((r: any) => filesToClean.push(r.photo_path));

    const sponsorSigns = await sql`
      SELECT signature_path FROM associate_sponsor 
      WHERE associate_id IN ${sql(enrollmentIds)} AND signature_path IS NOT NULL
    `;
    sponsorSigns.forEach((r: any) => filesToClean.push(r.signature_path));
  }

  if (uid > 0) {
    const userDocs = await sql`
      SELECT file_path, cloudinary_public_id FROM user_documents 
      WHERE user_id = ${uid}
    `;
    userDocs.forEach((d: any) => {
      fileObjectsToClean.push({ url: d.file_path, publicId: d.cloudinary_public_id });
    });

    const [userPhoto] = await sql`
      SELECT profile_picture_url, profile_photo FROM users WHERE user_id = ${uid}
    `;
    if (userPhoto?.profile_picture_url) filesToClean.push(userPhoto.profile_picture_url);
    if (userPhoto?.profile_photo) filesToClean.push(userPhoto.profile_photo);
  }

  // 4. Execute Transactional Database Cleanup
  await sql.begin(async (tx: any) => {
    // 4a. Team Members: Detach or clean self-records
    if (uid > 0 || memberId) {
      await tx`UPDATE team_members SET user_id = NULL WHERE user_id = ${uid > 0 ? uid : -1}`;
      await tx`
        UPDATE team_members 
        SET associate_id = 0, associate_name = 'Unassigned' 
        WHERE associate_id = ${uid > 0 ? uid : -1} 
           OR associate_name = ${resolvedMemberId}
      `;
    }

    // 4b. MLM & Network Tree Hierarchy Reassignment / Detach
    if (uid > 0) {
      await tx`
        UPDATE users 
        SET sponsor_user_id = 1 
        WHERE sponsor_user_id = ${uid} AND user_id != ${uid}
      `;

      await tx`
        UPDATE referral_registrations 
        SET sponsor_user_id = 1 
        WHERE sponsor_user_id = ${uid} AND referred_user_id != ${uid}
      `;

      await tx`DELETE FROM associate_sales_tracker WHERE associate_user_id = ${uid}`;
      await tx`DELETE FROM associate_rank_history WHERE associate_user_id = ${uid}`;
      await tx`DELETE FROM associate_referral_links WHERE associate_user_id = ${uid}`;
      await tx`DELETE FROM mlm_network WHERE associate_user_id = ${uid} OR sponsor_user_id = ${uid}`;
      await tx`DELETE FROM mlm_tree_closure WHERE ancestor_user_id = ${uid} OR descendant_user_id = ${uid}`;
      await tx`DELETE FROM associate_network_closure WHERE ancestor_user_id = ${uid} OR descendant_user_id = ${uid}`;
      await tx`DELETE FROM referral_registrations WHERE referred_user_id = ${uid}`;
      await tx`DELETE FROM associate_payout_requests WHERE associate_user_id = ${uid}`;
      await tx`DELETE FROM payout_requests WHERE user_id = ${uid}`;
      await tx`DELETE FROM withdrawal_requests WHERE user_id = ${uid}`;
    }

    // 4c. Delete Associate Enrollment & All Child Tables
    if (enrollmentIds.length > 0) {
      await tx`DELETE FROM associate_address WHERE associate_id IN ${sql(enrollmentIds)}`;
      await tx`DELETE FROM associate_bank_details WHERE associate_id IN ${sql(enrollmentIds)}`;
      await tx`DELETE FROM associate_nominee WHERE associate_id IN ${sql(enrollmentIds)}`;
      await tx`DELETE FROM associate_sponsor WHERE associate_id IN ${sql(enrollmentIds)}`;
      await tx`DELETE FROM associate_enrollment WHERE id IN ${sql(enrollmentIds)}`;
    }
    if (uid > 0) {
      await tx`DELETE FROM associate_address WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
      await tx`DELETE FROM associate_bank_details WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
      await tx`DELETE FROM associate_nominee WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
      await tx`DELETE FROM associate_sponsor WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
      await tx`DELETE FROM associate_enrollment WHERE user_id = ${uid}`;
    }

    // 4d. Delete User Profile Support Tables
    if (uid > 0) {
      await tx`DELETE FROM user_addresses WHERE user_id = ${uid}`;
      await tx`DELETE FROM user_bank_details WHERE user_id = ${uid}`;
      await tx`DELETE FROM user_nominees WHERE user_id = ${uid}`;
      await tx`DELETE FROM user_kyc_profiles WHERE user_id = ${uid}`;
      await tx`DELETE FROM user_documents WHERE user_id = ${uid}`;
      await tx`DELETE FROM user_device_tokens WHERE user_id = ${uid}`;
      await tx`DELETE FROM wallet_transactions WHERE user_id = ${uid}`;
      await tx`DELETE FROM wallets WHERE user_id = ${uid}`;
      await tx`DELETE FROM otp_log WHERE reference_id = ${String(uid)} OR (${Boolean(mobile)} AND mobile_no = ${mobile || ''})`;

      // 4e. Buyer Bookings made BY this associate as a personal buyer
      const personalBookings = await tx`SELECT booking_id, plot_id FROM bookings WHERE user_id = ${uid}`;
      if (personalBookings.length > 0) {
        const plotIds = personalBookings.map((b: any) => b.plot_id).filter(Boolean);
        if (plotIds.length > 0) {
          await tx`UPDATE plots SET plot_status = 'Vacant'::plot_status_enum, is_booked = FALSE, updated_at = NOW() WHERE plot_id IN ${sql(plotIds)}`;
        }
        for (const bk of personalBookings) {
          const emiSchedules = await tx`SELECT emi_id FROM emi_schedules WHERE booking_id = ${bk.booking_id}`;
          if (emiSchedules.length > 0) {
            const emiIds = emiSchedules.map((e: any) => e.emi_id);
            await tx`DELETE FROM emi_payment_proofs WHERE emi_id IN ${sql(emiIds)}`;
            await tx`DELETE FROM emi_schedules WHERE booking_id = ${bk.booking_id}`;
          }
          await tx`DELETE FROM booking_payment_records WHERE booking_id = ${bk.booking_id}`;
          await tx`DELETE FROM booking_invoices WHERE booking_id = ${bk.booking_id}`;
          await tx`DELETE FROM buyback_applications WHERE booking_id = ${bk.booking_id}`;
          await tx`DELETE FROM buyback_requests WHERE booking_id = ${bk.booking_id}`;
          await tx`DELETE FROM invoices WHERE booking_id = ${bk.booking_id}`;
        }
        await tx`DELETE FROM bookings WHERE user_id = ${uid}`;
      }
      await tx`DELETE FROM invoices WHERE user_id = ${uid}`;

      // 4f. Preserve Customer Bookings where this Associate was merely the referring Agent
      await tx`UPDATE bookings SET associate_user_id = NULL WHERE associate_user_id = ${uid}`;

      // 4g. Delete Master User Record
      await tx`DELETE FROM users WHERE user_id = ${uid} AND LOWER(user_type::text) = 'associate'`;
    }

    // 4h. Record Audit Log
    const actorId = Number(adminActor.admin_id || adminActor.id) || 1;
    const actorName = String(adminActor.full_name || adminActor.username || "Admin");
    await tx`
      INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, details)
      VALUES (
        'Admin', 
        ${actorId}, 
        ${actorName},
        'AssociateManagement', 
        'Deleted', 
        'users', 
        ${uid > 0 ? String(uid) : resolvedMemberId},
        ${JSON.stringify({
          member_id: resolvedMemberId,
          full_name: resolvedName,
          cleaned_enrollment_ids: enrollmentIds,
          files_collected_count: filesToClean.length + fileObjectsToClean.length
        })}
      )
    `;
  });

  // 5. Post-Commit Physical File Cleanup (Safe & Protected)
  const fileCleanResult = await cleanupPhysicalFiles(filesToClean, fileObjectsToClean);

  return {
    success: true,
    message: `Associate ${resolvedName} (${resolvedMemberId}) and all profile-exclusive data deleted successfully.`,
    data: {
      userId: uid,
      memberId: resolvedMemberId,
      cleanedEnrollmentIds: enrollmentIds,
      filesDeleted: fileCleanResult.deletedCount,
      filesMissing: fileCleanResult.missingCount,
      warnings: fileCleanResult.warnings
    }
  };
}

/**
 * Permanently Delete a Customer Profile & ALL Exclusive Profile Data
 */
export async function deleteCustomerProfile(
  customerId: number | string, 
  adminActor: AdminActor = { admin_id: 1, full_name: "Admin" }
): Promise<CleanupResult> {
  const rawId = String(customerId || "").trim();
  if (!rawId) {
    const err: any = new Error("Customer ID is required");
    err.statusCode = 400;
    throw err;
  }

  const numId = !isNaN(Number(rawId)) ? Number(rawId) : 0;

  // 1. Resolve Target User
  const [targetUser] = await sql`
    SELECT user_id, member_id, full_name, email, mobile_no, pan_number, aadhar_number, user_type
    FROM users
    WHERE (user_id = ${numId} OR member_id = ${rawId})
      AND LOWER(user_type::text) = 'customer'
    LIMIT 1
  `;

  // 2. Resolve Matching Customer Enrollment Submissions
  const uid = targetUser?.user_id || (numId > 0 ? numId : 0);
  const mobile = targetUser?.mobile_no ? String(targetUser.mobile_no).trim() : null;
  const pan = targetUser?.pan_number ? String(targetUser.pan_number).trim().toUpperCase() : null;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);

  const submissions = await sql`
    SELECT id, user_id, application_no, applicant_name,
           photo_first_applicant_url, photo_co_applicant_url,
           signature_sole_first_applicant_url, signature_co_applicant_url,
           signature_authorized_signatory_url
    FROM customer_enrollment_submissions
    WHERE (${isUuid} AND id = ${isUuid ? rawId : '00000000-0000-0000-0000-000000000000'})
       OR (${uid > 0} AND user_id = ${uid})
       OR (${Boolean(mobile)} AND mobile_1 = ${mobile})
       OR (${Boolean(pan)} AND UPPER(pan_no) = ${pan})
  `;

  if (!targetUser && (!submissions || submissions.length === 0)) {
    const err: any = new Error("Customer not found");
    err.statusCode = 404;
    throw err;
  }

  const resolvedName = targetUser?.full_name || submissions[0]?.applicant_name || "Customer";
  const submissionIds = submissions.map((s: any) => s.id).filter(Boolean);

  // 3. Collect ALL Physical File References (Before DB modifications)
  const filesToClean: string[] = [];
  const fileObjectsToClean: Array<{ url: string; publicId?: string }> = [];

  for (const s of submissions) {
    if (s.photo_first_applicant_url) filesToClean.push(s.photo_first_applicant_url);
    if (s.photo_co_applicant_url) filesToClean.push(s.photo_co_applicant_url);
    if (s.signature_sole_first_applicant_url) filesToClean.push(s.signature_sole_first_applicant_url);
    if (s.signature_co_applicant_url) filesToClean.push(s.signature_co_applicant_url);
    if (s.signature_authorized_signatory_url) filesToClean.push(s.signature_authorized_signatory_url);
  }

  if (uid > 0) {
    const userDocs = await sql`
      SELECT file_path, cloudinary_public_id FROM user_documents WHERE user_id = ${uid}
    `;
    userDocs.forEach((d: any) => {
      fileObjectsToClean.push({ url: d.file_path, publicId: d.cloudinary_public_id });
    });

    const [userPhoto] = await sql`
      SELECT profile_picture_url, profile_photo FROM users WHERE user_id = ${uid}
    `;
    if (userPhoto?.profile_picture_url) filesToClean.push(userPhoto.profile_picture_url);
    if (userPhoto?.profile_photo) filesToClean.push(userPhoto.profile_photo);
  }

  // 4. Execute Transactional Database Cleanup
  await sql.begin(async (tx: any) => {
    // 4a. Delete Customer Submissions & Nominees
    if (submissionIds.length > 0) {
      await tx`DELETE FROM customer_nominees WHERE submission_id IN ${sql(submissionIds)}`;
      await tx`DELETE FROM customer_enrollment_submissions WHERE id IN ${sql(submissionIds)}`;
    }
    if (uid > 0) {
      await tx`DELETE FROM customer_nominees WHERE submission_id IN (SELECT id FROM customer_enrollment_submissions WHERE user_id = ${uid})`;
      await tx`DELETE FROM customer_enrollment_submissions WHERE user_id = ${uid}`;
    }

    // 4b. Delete User Profile Support Tables
    if (uid > 0) {
      await tx`DELETE FROM user_addresses WHERE user_id = ${uid}`;
      await tx`DELETE FROM user_bank_details WHERE user_id = ${uid}`;
      await tx`DELETE FROM user_nominees WHERE user_id = ${uid}`;
      await tx`DELETE FROM user_kyc_profiles WHERE user_id = ${uid}`;
      await tx`DELETE FROM user_documents WHERE user_id = ${uid}`;
      await tx`DELETE FROM user_device_tokens WHERE user_id = ${uid}`;
      await tx`DELETE FROM wallet_transactions WHERE user_id = ${uid}`;
      await tx`DELETE FROM wallets WHERE user_id = ${uid}`;
      await tx`DELETE FROM referral_registrations WHERE referred_user_id = ${uid}`;
      await tx`DELETE FROM otp_log WHERE reference_id = ${String(uid)} OR (${Boolean(mobile)} AND mobile_no = ${mobile || ''})`;

      // 4c. Clean Customer Personal Bookings & Release Plots
      const bookings = await tx`SELECT booking_id, plot_id FROM bookings WHERE user_id = ${uid}`;
      if (bookings.length > 0) {
        const plotIds = bookings.map((b: any) => b.plot_id).filter(Boolean);
        if (plotIds.length > 0) {
          await tx`UPDATE plots SET plot_status = 'Vacant'::plot_status_enum, is_booked = FALSE, updated_at = NOW() WHERE plot_id IN ${sql(plotIds)}`;
        }
        for (const bk of bookings) {
          const emiSchedules = await tx`SELECT emi_id FROM emi_schedules WHERE booking_id = ${bk.booking_id}`;
          if (emiSchedules.length > 0) {
            const emiIds = emiSchedules.map((e: any) => e.emi_id);
            await tx`DELETE FROM emi_payment_proofs WHERE emi_id IN ${sql(emiIds)}`;
            await tx`DELETE FROM emi_schedules WHERE booking_id = ${bk.booking_id}`;
          }
          await tx`DELETE FROM booking_payment_records WHERE booking_id = ${bk.booking_id}`;
          await tx`DELETE FROM booking_invoices WHERE booking_id = ${bk.booking_id}`;
          await tx`DELETE FROM buyback_applications WHERE booking_id = ${bk.booking_id}`;
          await tx`DELETE FROM buyback_requests WHERE booking_id = ${bk.booking_id}`;
          await tx`DELETE FROM invoices WHERE booking_id = ${bk.booking_id}`;
        }
        await tx`DELETE FROM bookings WHERE user_id = ${uid}`;
      }
      await tx`DELETE FROM invoices WHERE user_id = ${uid}`;

      // 4d. Delete User Record
      await tx`DELETE FROM users WHERE user_id = ${uid} AND LOWER(user_type::text) = 'customer'`;
    }

    // 4e. Record Audit Log
    const actorId = Number(adminActor.admin_id || adminActor.id) || 1;
    const actorName = String(adminActor.full_name || adminActor.username || "Admin");
    await tx`
      INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, details)
      VALUES (
        'Admin', 
        ${actorId}, 
        ${actorName},
        'CustomerManagement', 
        'Deleted', 
        'users', 
        ${uid > 0 ? String(uid) : (submissionIds[0] || rawId)},
        ${JSON.stringify({
          full_name: resolvedName,
          cleaned_submissions: submissionIds,
          files_collected_count: filesToClean.length + fileObjectsToClean.length
        })}
      )
    `;
  });

  // 5. Post-Commit Physical File Cleanup
  const fileCleanResult = await cleanupPhysicalFiles(filesToClean, fileObjectsToClean);

  return {
    success: true,
    message: `Customer ${resolvedName} and all profile-exclusive data deleted successfully.`,
    data: {
      userId: uid,
      cleanedSubmissions: submissionIds,
      filesDeleted: fileCleanResult.deletedCount,
      filesMissing: fileCleanResult.missingCount,
      warnings: fileCleanResult.warnings
    }
  };
}

/**
 * Permanently Delete an Investor Profile & ALL Exclusive Profile Data
 */
export async function deleteInvestorProfile(
  investorId: number | string, 
  adminActor: AdminActor = { admin_id: 1, full_name: "Admin" }
): Promise<CleanupResult> {
  const rawId = String(investorId || "").trim();
  if (!rawId) {
    const err: any = new Error("Investor ID is required");
    err.statusCode = 400;
    throw err;
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
  let targetInvestorId: number | null = null;
  let targetEnrollmentId: string | null = isUuid ? rawId : null;

  if (isUuid) {
    const [enrollment] = await sql`SELECT id, investor_id FROM investor_enrollments WHERE id = ${rawId}`;
    if (enrollment) {
      targetEnrollmentId = enrollment.id;
      targetInvestorId = enrollment.investor_id;
    }
  } else if (!isNaN(Number(rawId))) {
    const numId = Number(rawId);
    const [invUser] = await sql`SELECT id FROM investor_users WHERE id = ${numId}`;
    if (invUser) {
      targetInvestorId = invUser.id;
    } else {
      const [enrollment] = await sql`SELECT id, investor_id FROM investor_enrollments WHERE investor_id = ${numId} LIMIT 1`;
      if (enrollment) {
        targetEnrollmentId = enrollment.id;
        targetInvestorId = enrollment.investor_id || numId;
      } else {
        const [showcase] = await sql`SELECT id, user_id FROM investors WHERE id = ${numId} OR user_id = ${numId} LIMIT 1`;
        if (showcase) {
          targetInvestorId = showcase.user_id || showcase.id;
        } else {
          targetInvestorId = numId;
        }
      }
    }
  }

  if (!targetInvestorId && !targetEnrollmentId) {
    const err: any = new Error("Investor not found");
    err.statusCode = 404;
    throw err;
  }

  // 1. Collect ALL Physical Files (Before DB Deletions)
  const filesToClean: string[] = [];
  const fileObjectsToClean: Array<{ url: string; publicId?: string }> = [];

  if (targetInvestorId) {
    const [invUser] = await sql`SELECT profile_picture_url FROM investor_users WHERE id = ${targetInvestorId}`;
    if (invUser?.profile_picture_url) filesToClean.push(invUser.profile_picture_url);

    const deposits = await sql`SELECT payment_screenshot_url FROM investor_deposits WHERE investor_id = ${targetInvestorId} AND payment_screenshot_url IS NOT NULL`;
    deposits.forEach((d: any) => filesToClean.push(d.payment_screenshot_url));

    const docs = await sql`SELECT document_path FROM investor_documents WHERE investor_id = ${targetInvestorId} AND document_path IS NOT NULL`;
    docs.forEach((d: any) => filesToClean.push(d.document_path));

    const [showcase] = await sql`SELECT profile_image_url, profile_image_public_id FROM investors WHERE user_id = ${targetInvestorId} OR id = ${targetInvestorId}`;
    if (showcase?.profile_image_url || showcase?.profile_image_public_id) {
      fileObjectsToClean.push({ url: showcase.profile_image_url, publicId: showcase.profile_image_public_id });
    }
  }

  // 2. Execute Transactional Database Cleanup
  await sql.begin(async (tx: any) => {
    if (targetInvestorId) {
      await tx`DELETE FROM investors WHERE user_id = ${targetInvestorId} OR id = ${targetInvestorId}`;
      await tx`DELETE FROM investor_deposits WHERE investor_id = ${targetInvestorId}`;
      await tx`DELETE FROM investor_documents WHERE investor_id = ${targetInvestorId}`;
      await tx`DELETE FROM investor_notifications WHERE investor_id = ${targetInvestorId}`;
      await tx`DELETE FROM investor_settlement_preferences WHERE investor_id = ${targetInvestorId}`;
      await tx`DELETE FROM settlement_change_requests WHERE investor_id = ${targetInvestorId}`;
      await tx`DELETE FROM investor_transactions WHERE investor_id = ${targetInvestorId}`;
      await tx`DELETE FROM investor_withdrawals WHERE investor_id = ${targetInvestorId}`;
      await tx`DELETE FROM investor_wallet WHERE investor_id = ${targetInvestorId}`;
      await tx`DELETE FROM investor_enrollments WHERE investor_id = ${targetInvestorId}`;
      await tx`DELETE FROM investor_users WHERE id = ${targetInvestorId}`;
    }

    if (targetEnrollmentId) {
      await tx`DELETE FROM investor_enrollments WHERE id = ${targetEnrollmentId}`;
    }

    // Record Audit Log
    const actorId = Number(adminActor.admin_id || adminActor.id) || 1;
    const actorName = String(adminActor.full_name || adminActor.username || "Admin");
    await tx`
      INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, details)
      VALUES (
        'Admin', 
        ${actorId}, 
        ${actorName},
        'InvestorManagement', 
        'Deleted', 
        'investor_users', 
        ${targetInvestorId ? String(targetInvestorId) : String(targetEnrollmentId)},
        ${JSON.stringify({
          investor_id: targetInvestorId,
          enrollment_id: targetEnrollmentId,
          files_collected_count: filesToClean.length + fileObjectsToClean.length
        })}
      )
    `;
  });

  // 3. Post-Commit Physical File Cleanup
  const fileCleanResult = await cleanupPhysicalFiles(filesToClean, fileObjectsToClean);

  return {
    success: true,
    message: "Investor and all profile-exclusive data deleted successfully.",
    data: {
      investorId: targetInvestorId,
      enrollmentId: targetEnrollmentId,
      filesDeleted: fileCleanResult.deletedCount,
      filesMissing: fileCleanResult.missingCount,
      warnings: fileCleanResult.warnings
    }
  };
}

export default {
  deleteAssociateProfile,
  deleteCustomerProfile,
  deleteInvestorProfile,
  cleanupPhysicalFiles
};
