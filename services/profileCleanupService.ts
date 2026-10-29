import sql from "../db.js";
import { deleteFileFromStorage, getStorageRoot } from "./fileStorage.service.js";
import fs from "fs";
import path from "path";

/**
 * Profile Cleanup Service — MMR Constructions (TypeScript Source)
 * Safely removes user profiles, related relational records, and uploaded physical files.
 */

async function safeTxExec(tx: any, label: string, fn: (sp: any) => Promise<void>): Promise<void> {
  try {
    await tx.savepoint(async (sp: any) => {
      await fn(sp);
    });
  } catch (err: any) {
    console.warn(`[ProfileCleanupService] Safe cleanup skipped for [${label}]:`, err.message);
  }
}

export async function cleanupPhysicalFiles(fileUrls: string[] = [], fileObjects: Array<{ url: string; publicId?: string }> = []) {
  const allTargets: Array<{ url: string; publicId: string }> = [];
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

  const storageRoot = (getStorageRoot as any) ? (getStorageRoot as any)() : path.resolve(process.cwd(), "uploads");

  for (const target of allTargets) {
    try {
      let ok = false;
      try {
        ok = await deleteFileFromStorage(target.url, target.publicId);
      } catch (_) {}

      if (!ok && target.url && typeof target.url === "string") {
        const match = target.url.match(/\/uploads\/(.+)$/) || target.url.match(/^uploads\/(.+)$/);
        if (match) {
          const localPath = path.resolve(storageRoot, match[1]);
          if (fs.existsSync(localPath)) {
            try {
              fs.unlinkSync(localPath);
              ok = true;
            } catch (unlinkErr: any) {
              console.warn(`[ProfileCleanupService] Local disk unlink error: ${unlinkErr.message}`);
            }
          }
        }
      }

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

export async function deleteAssociateProfile(associateId: string | number, adminActor = { admin_id: 1, full_name: "Admin" }) {
  const rawId = String(associateId || "").trim();
  if (!rawId) {
    const err: any = new Error("Associate ID is required");
    err.statusCode = 400;
    throw err;
  }

  const numId = !isNaN(Number(rawId)) ? Number(rawId) : 0;

  const [targetUser] = await sql`
    SELECT user_id, member_id, full_name, email, mobile_no, pan_number, aadhar_number, user_type
    FROM users
    WHERE (user_id = ${numId} OR member_id = ${rawId})
      AND LOWER(user_type::text) = 'associate'
    LIMIT 1
  `;

  const uid = targetUser?.user_id || (numId > 0 ? numId : 0);
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

  const filesToClean: string[] = [];
  const fileObjectsToClean: Array<{ url: string; publicId?: string }> = [];

  for (const e of enrollments) {
    if (e.applicant_photo_path) filesToClean.push(e.applicant_photo_path);
    if (e.signature_path) filesToClean.push(e.signature_path);
    if (e.print_pdf_path) filesToClean.push(e.print_pdf_path);
  }

  if (enrollmentIds.length > 0) {
    try {
      const nomineePhotos = await sql`
        SELECT photo_path FROM associate_nominee 
        WHERE associate_id IN ${sql(enrollmentIds)} AND photo_path IS NOT NULL
      `;
      nomineePhotos.forEach((r: any) => filesToClean.push(r.photo_path));
    } catch (_) {}

    try {
      const sponsorSigns = await sql`
        SELECT signature_path FROM associate_sponsor 
        WHERE associate_id IN ${sql(enrollmentIds)} AND signature_path IS NOT NULL
      `;
      sponsorSigns.forEach((r: any) => filesToClean.push(r.signature_path));
    } catch (_) {}
  }

  if (uid > 0) {
    try {
      const userDocs = await sql`
        SELECT file_path, cloudinary_public_id FROM user_documents 
        WHERE user_id = ${uid}
      `;
      userDocs.forEach((d: any) => {
        fileObjectsToClean.push({ url: d.file_path, publicId: d.cloudinary_public_id });
      });
    } catch (_) {}

    try {
      const [userPhoto] = await sql`
        SELECT profile_photo, profile_image FROM users WHERE user_id = ${uid}
      `;
      if (userPhoto?.profile_photo) filesToClean.push(userPhoto.profile_photo);
      if (userPhoto?.profile_image) filesToClean.push(userPhoto.profile_image);
    } catch (_) {}
  }

  await sql.begin(async (tx: any) => {
    if (uid > 0 || memberId) {
      await safeTxExec(tx, "team_members_user_detach", async (sp) => {
        await sp`UPDATE team_members SET user_id = NULL WHERE user_id = ${uid > 0 ? uid : -1}`;
      });
      await safeTxExec(tx, "team_members_assoc_detach", async (sp) => {
        await sp`
          UPDATE team_members 
          SET associate_id = 0, associate_name = 'Unassigned' 
          WHERE associate_id = ${uid > 0 ? uid : -1} 
             OR associate_name = ${resolvedMemberId}
        `;
      });
    }

    if (uid > 0) {
      await safeTxExec(tx, "users_sponsor_reassign", async (sp) => {
        await sp`UPDATE users SET sponsor_user_id = 1 WHERE sponsor_user_id = ${uid} AND user_id != ${uid}`;
      });
      await safeTxExec(tx, "referral_sponsor_reassign", async (sp) => {
        await sp`UPDATE referral_registrations SET sponsor_user_id = 1 WHERE sponsor_user_id = ${uid} AND referred_user_id != ${uid}`;
      });
      await safeTxExec(tx, "associate_sales_tracker", async (sp) => {
        await sp`DELETE FROM associate_sales_tracker WHERE associate_user_id = ${uid}`;
      });
      await safeTxExec(tx, "associate_rank_history", async (sp) => {
        await sp`DELETE FROM associate_rank_history WHERE associate_user_id = ${uid}`;
      });
      await safeTxExec(tx, "associate_referral_links", async (sp) => {
        await sp`DELETE FROM associate_referral_links WHERE associate_user_id = ${uid}`;
      });
      await safeTxExec(tx, "associate_status_history", async (sp) => {
        await sp`DELETE FROM associate_status_history WHERE associate_user_id = ${uid}`;
      });
      await safeTxExec(tx, "mlm_network", async (sp) => {
        await sp`DELETE FROM mlm_network WHERE associate_user_id = ${uid} OR sponsor_user_id = ${uid}`;
      });
      await safeTxExec(tx, "mlm_tree_closure", async (sp) => {
        await sp`DELETE FROM mlm_tree_closure WHERE ancestor_user_id = ${uid} OR descendant_user_id = ${uid}`;
      });
      await safeTxExec(tx, "associate_network_closure", async (sp) => {
        await sp`DELETE FROM associate_network_closure WHERE ancestor_user_id = ${uid} OR descendant_user_id = ${uid}`;
      });
      await safeTxExec(tx, "referral_registrations", async (sp) => {
        await sp`DELETE FROM referral_registrations WHERE referred_user_id = ${uid}`;
      });
      await safeTxExec(tx, "referral_clicks", async (sp) => {
        await sp`DELETE FROM referral_clicks WHERE associate_user_id = ${uid}`;
      });
      await safeTxExec(tx, "associate_payout_requests", async (sp) => {
        await sp`DELETE FROM associate_payout_requests WHERE associate_user_id = ${uid}`;
      });
      await safeTxExec(tx, "payout_requests", async (sp) => {
        await sp`DELETE FROM payout_requests WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "withdrawal_requests", async (sp) => {
        await sp`DELETE FROM withdrawal_requests WHERE user_id = ${uid}`;
      });
    }

    if (enrollmentIds.length > 0) {
      await safeTxExec(tx, "associate_address", async (sp) => {
        await sp`DELETE FROM associate_address WHERE associate_id IN ${sql(enrollmentIds)}`;
      });
      await safeTxExec(tx, "associate_bank_details", async (sp) => {
        await sp`DELETE FROM associate_bank_details WHERE associate_id IN ${sql(enrollmentIds)}`;
      });
      await safeTxExec(tx, "associate_nominee", async (sp) => {
        await sp`DELETE FROM associate_nominee WHERE associate_id IN ${sql(enrollmentIds)}`;
      });
      await safeTxExec(tx, "associate_sponsor", async (sp) => {
        await sp`DELETE FROM associate_sponsor WHERE associate_id IN ${sql(enrollmentIds)}`;
      });
      await safeTxExec(tx, "associate_enrollment", async (sp) => {
        await sp`DELETE FROM associate_enrollment WHERE id IN ${sql(enrollmentIds)}`;
      });
    }

    if (uid > 0) {
      await safeTxExec(tx, "associate_enrollment_by_user", async (sp) => {
        await sp`DELETE FROM associate_address WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
        await sp`DELETE FROM associate_bank_details WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
        await sp`DELETE FROM associate_nominee WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
        await sp`DELETE FROM associate_sponsor WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
        await sp`DELETE FROM associate_enrollment WHERE user_id = ${uid}`;
      });

      await safeTxExec(tx, "user_addresses", async (sp) => {
        await sp`DELETE FROM user_addresses WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_bank_details", async (sp) => {
        await sp`DELETE FROM user_bank_details WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_nominees", async (sp) => {
        await sp`DELETE FROM user_nominees WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_kyc_profiles", async (sp) => {
        await sp`DELETE FROM user_kyc_profiles WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_documents", async (sp) => {
        await sp`DELETE FROM user_documents WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_device_tokens", async (sp) => {
        await sp`DELETE FROM user_device_tokens WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "notification_log", async (sp) => {
        await sp`DELETE FROM notification_log WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "wallet_transactions", async (sp) => {
        await sp`DELETE FROM wallet_transactions WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "wallet_audit_logs", async (sp) => {
        await sp`DELETE FROM wallet_audit_logs WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_wallets", async (sp) => {
        await sp`DELETE FROM user_wallets WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "otp_log", async (sp) => {
        await sp`DELETE FROM otp_log WHERE reference_id = ${String(uid)} OR (${Boolean(mobile)} AND (mobile_no = ${mobile || ''} OR mobile = ${mobile || ''}))`;
      });
      await safeTxExec(tx, "email_otp_log", async (sp) => {
        if (email) await sp`DELETE FROM email_otp_log WHERE email = ${email}`;
      });

      await safeTxExec(tx, "bookings_personal", async (sp) => {
        const personalBookings = await sp`SELECT booking_id, plot_id FROM bookings WHERE user_id = ${uid}`;
        if (personalBookings.length > 0) {
          const plotIds = personalBookings.map((b: any) => b.plot_id).filter(Boolean);
          if (plotIds.length > 0) {
            await sp`UPDATE plots SET plot_status = 'Vacant'::plot_status_enum, is_booked = FALSE, updated_at = NOW() WHERE plot_id IN ${sql(plotIds)}`;
          }
          for (const bk of personalBookings) {
            const emiSchedules = await sp`SELECT emi_id FROM emi_schedules WHERE booking_id = ${bk.booking_id}`;
            if (emiSchedules.length > 0) {
              const emiIds = emiSchedules.map((e: any) => e.emi_id);
              await sp`DELETE FROM emi_payment_proofs WHERE emi_id IN ${sql(emiIds)}`;
              await sp`DELETE FROM emi_schedules WHERE booking_id = ${bk.booking_id}`;
            }
            await sp`DELETE FROM booking_payment_records WHERE booking_id = ${bk.booking_id}`;
            await sp`DELETE FROM booking_payment_proofs WHERE booking_id = ${bk.booking_id}`;
            await sp`DELETE FROM buyback_applications WHERE booking_id = ${bk.booking_id}`;
            await sp`DELETE FROM invoices WHERE booking_id = ${bk.booking_id}`;
          }
          await sp`DELETE FROM bookings WHERE user_id = ${uid}`;
        }
      });

      await safeTxExec(tx, "invoices", async (sp) => {
        await sp`DELETE FROM invoices WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "bookings_associate_detach", async (sp) => {
        await sp`UPDATE bookings SET associate_user_id = NULL WHERE associate_user_id = ${uid}`;
      });
      await safeTxExec(tx, "users_master", async (sp) => {
        await sp`DELETE FROM users WHERE user_id = ${uid}`;
      });
    }

    await safeTxExec(tx, "audit_log", async (sp) => {
      const actorId = Number(adminActor.admin_id || (adminActor as any).id) || 1;
      const actorName = String(adminActor.full_name || (adminActor as any).username || "Admin");
      await sp`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
        VALUES (
          'Admin', 
          ${actorId}, 
          ${actorName}, 
          'AssociateManagement', 
          'Deleted', 
          'users', 
          ${uid > 0 ? uid : null}, 
          ${JSON.stringify({
            member_id: resolvedMemberId,
            full_name: resolvedName,
            cleaned_enrollment_ids: enrollmentIds,
            files_collected_count: filesToClean.length + fileObjectsToClean.length
          })}
        )
      `;
    });
  });

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

export async function deleteCustomerProfile(customerId: string | number, adminActor = { admin_id: 1, full_name: "Admin" }) {
  const rawId = String(customerId || "").trim();
  if (!rawId) {
    const err: any = new Error("Customer ID is required");
    err.statusCode = 400;
    throw err;
  }

  const numId = !isNaN(Number(rawId)) ? Number(rawId) : 0;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);

  const [targetUser] = await sql`
    SELECT user_id, member_id, full_name, email, mobile_no, pan_number, aadhar_number, user_type
    FROM users
    WHERE (user_id = ${numId} OR member_id = ${rawId})
      AND LOWER(user_type::text) = 'customer'
    LIMIT 1
  `;

  const uid = targetUser?.user_id || (numId > 0 ? numId : 0);
  const mobile = targetUser?.mobile_no ? String(targetUser.mobile_no).trim() : null;
  const pan = targetUser?.pan_number ? String(targetUser.pan_number).trim().toUpperCase() : null;
  const email = targetUser?.email ? String(targetUser.email).trim().toLowerCase() : null;

  let submissions: any[] = [];
  if (isUuid) {
    submissions = await sql`
      SELECT id, user_id, application_no, applicant_name,
             photo_first_applicant_url, photo_co_applicant_url,
             signature_sole_first_applicant_url, signature_co_applicant_url,
             signature_authorized_signatory_url
      FROM customer_enrollment_submissions
      WHERE id = ${rawId}::uuid
    `;
  } else {
    submissions = await sql`
      SELECT id, user_id, application_no, applicant_name,
             photo_first_applicant_url, photo_co_applicant_url,
             signature_sole_first_applicant_url, signature_co_applicant_url,
             signature_authorized_signatory_url
      FROM customer_enrollment_submissions
      WHERE (${uid > 0} AND user_id = ${uid})
         OR (${Boolean(mobile)} AND mobile_1 = ${mobile})
         OR (${Boolean(pan)} AND UPPER(pan_no) = ${pan})
    `;
  }

  if (!targetUser && (!submissions || submissions.length === 0)) {
    const err: any = new Error("Customer not found");
    err.statusCode = 404;
    throw err;
  }

  const resolvedName = targetUser?.full_name || submissions[0]?.applicant_name || "Customer";
  const submissionIds = submissions.map((s: any) => s.id).filter(Boolean);

  const filesToClean: string[] = [];
  const fileObjectsToClean: Array<{ url: string; publicId?: string }> = [];

  for (const s of submissions) {
    if (s.photo_first_applicant_url) filesToClean.push(s.photo_first_applicant_url);
    if (s.photo_co_applicant_url) filesToClean.push(s.photo_co_applicant_url);
    if (s.signature_sole_first_applicant_url) filesToClean.push(s.signature_sole_first_applicant_url);
    if (s.signature_co_applicant_url) filesToClean.push(s.signature_co_applicant_url);
    if (s.signature_authorized_signatory_url) filesToClean.push(s.signature_authorized_signatory_url);
    if (s.print_pdf_path) filesToClean.push(s.print_pdf_path);
  }

  if (uid > 0) {
    try {
      const userDocs = await sql`
        SELECT file_path, cloudinary_public_id FROM user_documents WHERE user_id = ${uid}
      `;
      userDocs.forEach((d: any) => {
        fileObjectsToClean.push({ url: d.file_path, publicId: d.cloudinary_public_id });
      });
    } catch (_) {}

    try {
      const [userPhoto] = await sql`
        SELECT profile_photo, profile_image FROM users WHERE user_id = ${uid}
      `;
      if (userPhoto?.profile_photo) filesToClean.push(userPhoto.profile_photo);
      if (userPhoto?.profile_image) filesToClean.push(userPhoto.profile_image);
    } catch (_) {}

    try {
      const bookingProofs = await sql`
        SELECT proof_url FROM booking_payment_proofs 
        WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
          AND proof_url IS NOT NULL
      `;
      bookingProofs.forEach((r: any) => { if (r.proof_url) filesToClean.push(r.proof_url); });
    } catch (_) {}

    try {
      const emiProofs = await sql`
        SELECT proof_url FROM emi_payment_proofs 
        WHERE emi_id IN (
          SELECT emi_id FROM emi_schedules 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        ) AND proof_url IS NOT NULL
      `;
      emiProofs.forEach((r: any) => { if (r.proof_url) filesToClean.push(r.proof_url); });
    } catch (_) {}
  }

  await sql.begin(async (tx: any) => {
    if (uid > 0) {
      await safeTxExec(tx, "emi_payment_proofs", async (sp) => {
        await sp`
          DELETE FROM emi_payment_proofs 
          WHERE emi_id IN (
            SELECT emi_id FROM emi_schedules 
            WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
          )
        `;
      });

      await safeTxExec(tx, "emi_schedules", async (sp) => {
        await sp`
          DELETE FROM emi_schedules 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "booking_appointments", async (sp) => {
        await sp`
          DELETE FROM booking_appointments 
          WHERE user_id = ${uid} 
             OR booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "booking_payment_proofs", async (sp) => {
        await sp`
          DELETE FROM booking_payment_proofs 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "booking_payment_records", async (sp) => {
        await sp`
          DELETE FROM booking_payment_records 
          WHERE user_id = ${uid} 
             OR booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "buyback_applications", async (sp) => {
        await sp`
          DELETE FROM buyback_applications 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "commission_monthly_schedule", async (sp) => {
        await sp`
          DELETE FROM commission_monthly_schedule 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "commission_source_events", async (sp) => {
        await sp`
          DELETE FROM commission_source_events 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "invoices", async (sp) => {
        await sp`
          DELETE FROM invoices 
          WHERE user_id = ${uid} 
             OR booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "receipts", async (sp) => {
        await sp`
          DELETE FROM receipts 
          WHERE customer_id = ${uid} 
             OR (${Boolean(mobile)} AND mobile_no = ${mobile})
        `;
      });

      await safeTxExec(tx, "plot_booking_history", async (sp) => {
        await sp`
          DELETE FROM plot_booking_history 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "plot_booking_locks", async (sp) => {
        await sp`
          DELETE FROM plot_booking_locks 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "payment_allocations", async (sp) => {
        await sp`
          DELETE FROM payment_allocations 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "payment_ledger", async (sp) => {
        await sp`
          DELETE FROM payment_ledger 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "cash_collections", async (sp) => {
        await sp`
          DELETE FROM cash_collections 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "cheque_registry", async (sp) => {
        await sp`
          DELETE FROM cheque_registry 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "missing_payment_complaints", async (sp) => {
        await sp`
          DELETE FROM missing_payment_complaints 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "registry_records", async (sp) => {
        await sp`
          DELETE FROM registry_records 
          WHERE booking_id IN (SELECT booking_id FROM bookings WHERE user_id = ${uid})
        `;
      });

      await safeTxExec(tx, "reset_plots_and_bookings", async (sp) => {
        const bks = await sp`SELECT plot_id FROM bookings WHERE user_id = ${uid}`;
        const plotIds = bks.map((b: any) => b.plot_id).filter(Boolean);
        if (plotIds.length > 0) {
          await sp`
            UPDATE plots 
            SET plot_status = 'Vacant'::plot_status_enum, is_booked = FALSE, updated_at = NOW() 
            WHERE plot_id IN ${sql(plotIds)}
          `;
        }
        await sp`DELETE FROM bookings WHERE user_id = ${uid}`;
      });
    }

    if (submissionIds.length > 0) {
      await safeTxExec(tx, "customer_nominees_by_sub_ids", async (sp) => {
        await sp`DELETE FROM customer_nominees WHERE submission_id IN ${sql(submissionIds)}`;
      });
      await safeTxExec(tx, "customer_enrollment_submissions_by_ids", async (sp) => {
        await sp`DELETE FROM customer_enrollment_submissions WHERE id IN ${sql(submissionIds)}`;
      });
    }

    if (uid > 0) {
      await safeTxExec(tx, "customer_nominees_by_user", async (sp) => {
        await sp`
          DELETE FROM customer_nominees 
          WHERE submission_id IN (SELECT id FROM customer_enrollment_submissions WHERE user_id = ${uid})
        `;
      });
      await safeTxExec(tx, "customer_enrollment_submissions_by_user", async (sp) => {
        await sp`DELETE FROM customer_enrollment_submissions WHERE user_id = ${uid}`;
      });

      await safeTxExec(tx, "user_addresses", async (sp) => {
        await sp`DELETE FROM user_addresses WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_bank_details", async (sp) => {
        await sp`DELETE FROM user_bank_details WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_nominees", async (sp) => {
        await sp`DELETE FROM user_nominees WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_kyc_profiles", async (sp) => {
        await sp`DELETE FROM user_kyc_profiles WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_documents", async (sp) => {
        await sp`DELETE FROM user_documents WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_device_tokens", async (sp) => {
        await sp`DELETE FROM user_device_tokens WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "notification_log", async (sp) => {
        await sp`DELETE FROM notification_log WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "inquiries", async (sp) => {
        await sp`DELETE FROM inquiries WHERE user_id = ${uid} OR (${Boolean(mobile)} AND mobile_no = ${mobile})`;
      });
      await safeTxExec(tx, "wallet_transactions", async (sp) => {
        await sp`DELETE FROM wallet_transactions WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "wallet_audit_logs", async (sp) => {
        await sp`DELETE FROM wallet_audit_logs WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "user_wallets", async (sp) => {
        await sp`DELETE FROM user_wallets WHERE user_id = ${uid}`;
      });
      await safeTxExec(tx, "referral_registrations", async (sp) => {
        await sp`DELETE FROM referral_registrations WHERE referred_user_id = ${uid} OR sponsor_user_id = ${uid}`;
      });
      await safeTxExec(tx, "otp_log", async (sp) => {
        await sp`
          DELETE FROM otp_log 
          WHERE reference_id = ${String(uid)} 
             OR (${Boolean(mobile)} AND (mobile_no = ${mobile || ''} OR mobile = ${mobile || ''}))
        `;
      });
      await safeTxExec(tx, "email_otp_log", async (sp) => {
        if (email) await sp`DELETE FROM email_otp_log WHERE email = ${email}`;
      });
      await safeTxExec(tx, "detach_sponsor_and_team", async (sp) => {
        await sp`UPDATE users SET sponsor_user_id = 1 WHERE sponsor_user_id = ${uid}`;
        await sp`UPDATE team_members SET user_id = NULL WHERE user_id = ${uid}`;
      });

      await safeTxExec(tx, "users_master", async (sp) => {
        await sp`DELETE FROM users WHERE user_id = ${uid}`;
      });
    }

    await safeTxExec(tx, "audit_log", async (sp) => {
      const actorId = Number(adminActor.admin_id || (adminActor as any).id) || 1;
      const actorName = String(adminActor.full_name || (adminActor as any).username || "Admin");
      await sp`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
        VALUES (
          'Admin', 
          ${actorId}, 
          ${actorName}, 
          'CustomerManagement', 
          'Deleted', 
          'users', 
          ${uid > 0 ? uid : null}, 
          ${JSON.stringify({
            full_name: resolvedName,
            cleaned_submissions: submissionIds,
            files_collected_count: filesToClean.length + fileObjectsToClean.length
          })}
        )
      `;
    });
  });

  const fileCleanResult = await cleanupPhysicalFiles(filesToClean, fileObjectsToClean);

  return {
    success: true,
    message: `Customer ${resolvedName} and all profile-exclusive data and files deleted successfully.`,
    data: {
      userId: uid,
      cleanedSubmissions: submissionIds,
      filesDeleted: fileCleanResult.deletedCount,
      filesMissing: fileCleanResult.missingCount,
      warnings: fileCleanResult.warnings
    }
  };
}

export async function deleteInvestorProfile(investorId: string | number, adminActor = { admin_id: 1, full_name: "Admin" }) {
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
    try {
      const [enrollment] = await sql`SELECT id, investor_id FROM investor_enrollments WHERE id = ${rawId}`;
      if (enrollment) {
        targetInvestorId = enrollment.investor_id || null;
      }
    } catch (_) {}
  } else {
    targetInvestorId = Number(rawId);
  }

  const filesToClean: string[] = [];
  const fileObjectsToClean: Array<{ url: string; publicId?: string }> = [];

  if (targetInvestorId) {
    try {
      const docs = await sql`SELECT file_url FROM investor_documents WHERE investor_id = ${targetInvestorId}`;
      docs.forEach((d: any) => { if (d.file_url) filesToClean.push(d.file_url); });
    } catch (_) {}

    try {
      const [invUser] = await sql`SELECT profile_picture_url FROM investor_users WHERE id = ${targetInvestorId}`;
      if (invUser?.profile_picture_url) filesToClean.push(invUser.profile_picture_url);
    } catch (_) {}

    try {
      const deposits = await sql`SELECT payment_receipt_url FROM investor_deposits WHERE investor_id = ${targetInvestorId}`;
      deposits.forEach((d: any) => { if (d.payment_receipt_url) filesToClean.push(d.payment_receipt_url); });
    } catch (_) {}

    try {
      const enrolls = await sql`SELECT applicant_photo_url, signature_url FROM investor_enrollments WHERE investor_id = ${targetInvestorId}`;
      enrolls.forEach((e: any) => {
        if (e.applicant_photo_url) filesToClean.push(e.applicant_photo_url);
        if (e.signature_url) filesToClean.push(e.signature_url);
      });
    } catch (_) {}
  }

  await sql.begin(async (tx: any) => {
    if (targetInvestorId) {
      await safeTxExec(tx, "investors", async (sp) => {
        await sp`DELETE FROM investors WHERE user_id = ${targetInvestorId} OR id = ${targetInvestorId}`;
      });
      await safeTxExec(tx, "investor_deposits", async (sp) => {
        await sp`DELETE FROM investor_deposits WHERE investor_id = ${targetInvestorId}`;
      });
      await safeTxExec(tx, "investor_documents", async (sp) => {
        await sp`DELETE FROM investor_documents WHERE investor_id = ${targetInvestorId}`;
      });
      await safeTxExec(tx, "investor_notifications", async (sp) => {
        await sp`DELETE FROM investor_notifications WHERE investor_id = ${targetInvestorId}`;
      });
      await safeTxExec(tx, "investor_settlement_preferences", async (sp) => {
        await sp`DELETE FROM investor_settlement_preferences WHERE investor_id = ${targetInvestorId}`;
      });
      await safeTxExec(tx, "settlement_change_requests", async (sp) => {
        await sp`DELETE FROM settlement_change_requests WHERE investor_id = ${targetInvestorId}`;
      });
      await safeTxExec(tx, "investor_transactions", async (sp) => {
        await sp`DELETE FROM investor_transactions WHERE investor_id = ${targetInvestorId}`;
      });
      await safeTxExec(tx, "investor_withdrawals", async (sp) => {
        await sp`DELETE FROM investor_withdrawals WHERE investor_id = ${targetInvestorId}`;
      });
      await safeTxExec(tx, "investor_wallet", async (sp) => {
        await sp`DELETE FROM investor_wallet WHERE investor_id = ${targetInvestorId}`;
      });
      await safeTxExec(tx, "investor_enrollments", async (sp) => {
        await sp`DELETE FROM investor_enrollments WHERE investor_id = ${targetInvestorId}`;
      });
      await safeTxExec(tx, "investor_users", async (sp) => {
        await sp`DELETE FROM investor_users WHERE id = ${targetInvestorId}`;
      });
    }

    if (targetEnrollmentId) {
      await safeTxExec(tx, "investor_enrollments_by_id", async (sp) => {
        await sp`DELETE FROM investor_enrollments WHERE id = ${targetEnrollmentId}`;
      });
    }

    await safeTxExec(tx, "audit_log", async (sp) => {
      const actorId = Number(adminActor.admin_id || (adminActor as any).id) || 1;
      const actorName = String(adminActor.full_name || (adminActor as any).username || "Admin");
      await sp`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
        VALUES (
          'Admin', 
          ${actorId}, 
          ${actorName}, 
          'InvestorManagement', 
          'Deleted', 
          'users', 
          ${targetInvestorId ? targetInvestorId : null}, 
          ${JSON.stringify({
            investor_id: targetInvestorId,
            enrollment_id: targetEnrollmentId,
            files_collected_count: filesToClean.length + fileObjectsToClean.length
          })}
        )
      `;
    });
  });

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
