import sql from "../db.js";
import { deleteFileFromStorage } from "./fileStorage.service.js";
/**
 * Profile Cleanup Service — MMR Constructions (TypeScript Source)
 */
export async function cleanupPhysicalFiles(fileUrls = [], fileObjects = []) {
    const allTargets = [];
    const seen = new Set();
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
    const warnings = [];
    for (const target of allTargets) {
        try {
            const ok = await deleteFileFromStorage(target.url, target.publicId);
            if (ok) {
                deletedCount++;
            }
            else {
                missingCount++;
            }
        }
        catch (err) {
            missingCount++;
            warnings.push(`File cleanup skipped for ${target.url || target.publicId}: ${err.message}`);
            console.warn(`[ProfileCleanupService] File delete warning:`, err.message);
        }
    }
    return { deletedCount, missingCount, warnings };
}
export async function deleteAssociateProfile(associateId, adminActor = { admin_id: 1, full_name: "Admin" }) {
    const rawId = String(associateId || "").trim();
    if (!rawId) {
        const err = new Error("Associate ID is required");
        err.statusCode = 400;
        throw err;
    }
    const numId = !isNaN(Number(rawId)) ? Number(rawId) : 0;
    const [targetUser] = await sql `
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
    const enrollments = await sql `
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
        const err = new Error("Associate not found");
        err.statusCode = 404;
        throw err;
    }
    const resolvedName = targetUser?.full_name || enrollments[0]?.full_name || "Associate";
    const resolvedMemberId = targetUser?.member_id || enrollments[0]?.member_id || enrollments[0]?.id || rawId;
    const enrollmentIds = enrollments.map((e) => e.id).filter(Boolean);
    const filesToClean = [];
    const fileObjectsToClean = [];
    for (const e of enrollments) {
        if (e.applicant_photo_path)
            filesToClean.push(e.applicant_photo_path);
        if (e.signature_path)
            filesToClean.push(e.signature_path);
        if (e.print_pdf_path)
            filesToClean.push(e.print_pdf_path);
    }
    if (enrollmentIds.length > 0) {
        try {
            const nomineePhotos = await sql `
        SELECT photo_path FROM associate_nominee 
        WHERE associate_id IN ${sql(enrollmentIds)} AND photo_path IS NOT NULL
      `;
            nomineePhotos.forEach((r) => filesToClean.push(r.photo_path));
        }
        catch (_) { }
        try {
            const sponsorSigns = await sql `
        SELECT signature_path FROM associate_sponsor 
        WHERE associate_id IN ${sql(enrollmentIds)} AND signature_path IS NOT NULL
      `;
            sponsorSigns.forEach((r) => filesToClean.push(r.signature_path));
        }
        catch (_) { }
    }
    if (uid > 0) {
        try {
            const userDocs = await sql `
        SELECT file_path, cloudinary_public_id FROM user_documents 
        WHERE user_id = ${uid}
      `;
            userDocs.forEach((d) => {
                fileObjectsToClean.push({ url: d.file_path, publicId: d.cloudinary_public_id });
            });
        }
        catch (_) { }
        try {
            const [userPhoto] = await sql `
        SELECT profile_photo FROM users WHERE user_id = ${uid}
      `;
            if (userPhoto?.profile_photo)
                filesToClean.push(userPhoto.profile_photo);
        }
        catch (_) { }
    }
    await sql.begin(async (tx) => {
        if (uid > 0 || memberId) {
            try {
                await tx `UPDATE team_members SET user_id = NULL WHERE user_id = ${uid > 0 ? uid : -1}`;
            }
            catch (_) { }
            try {
                await tx `
          UPDATE team_members 
          SET associate_id = 0, associate_name = 'Unassigned' 
          WHERE associate_id = ${uid > 0 ? uid : -1} 
             OR associate_name = ${resolvedMemberId}
        `;
            }
            catch (_) { }
        }
        if (uid > 0) {
            try {
                await tx `
          UPDATE users 
          SET sponsor_user_id = 1 
          WHERE sponsor_user_id = ${uid} AND user_id != ${uid}
        `;
            }
            catch (_) { }
            try {
                await tx `
          UPDATE referral_registrations 
          SET sponsor_user_id = 1 
          WHERE sponsor_user_id = ${uid} AND referred_user_id != ${uid}
        `;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_sales_tracker WHERE associate_user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_rank_history WHERE associate_user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_referral_links WHERE associate_user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM mlm_network WHERE associate_user_id = ${uid} OR sponsor_user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM mlm_tree_closure WHERE ancestor_user_id = ${uid} OR descendant_user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_network_closure WHERE ancestor_user_id = ${uid} OR descendant_user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM referral_registrations WHERE referred_user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_payout_requests WHERE associate_user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM payout_requests WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM withdrawal_requests WHERE user_id = ${uid}`;
            }
            catch (_) { }
        }
        if (enrollmentIds.length > 0) {
            try {
                await tx `DELETE FROM associate_address WHERE associate_id IN ${sql(enrollmentIds)}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_bank_details WHERE associate_id IN ${sql(enrollmentIds)}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_nominee WHERE associate_id IN ${sql(enrollmentIds)}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_sponsor WHERE associate_id IN ${sql(enrollmentIds)}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_enrollment WHERE id IN ${sql(enrollmentIds)}`;
            }
            catch (_) { }
        }
        if (uid > 0) {
            try {
                await tx `DELETE FROM associate_address WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_bank_details WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_nominee WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_sponsor WHERE associate_id IN (SELECT id FROM associate_enrollment WHERE user_id = ${uid})`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM associate_enrollment WHERE user_id = ${uid}`;
            }
            catch (_) { }
        }
        if (uid > 0) {
            try {
                await tx `DELETE FROM user_addresses WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_bank_details WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_nominees WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_kyc_profiles WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_documents WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_device_tokens WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM wallet_transactions WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_wallets WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM wallets WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM otp_log WHERE reference_id = ${String(uid)} OR (${Boolean(mobile)} AND mobile_no = ${mobile || ''}) OR (${Boolean(mobile)} AND mobile = ${mobile || ''})`;
            }
            catch (_) { }
            try {
                const personalBookings = await tx `SELECT booking_id, plot_id FROM bookings WHERE user_id = ${uid}`;
                if (personalBookings.length > 0) {
                    const plotIds = personalBookings.map((b) => b.plot_id).filter(Boolean);
                    if (plotIds.length > 0) {
                        await tx `UPDATE plots SET plot_status = 'Vacant'::plot_status_enum, is_booked = FALSE, updated_at = NOW() WHERE plot_id IN ${sql(plotIds)}`;
                    }
                    for (const bk of personalBookings) {
                        const emiSchedules = await tx `SELECT emi_id FROM emi_schedules WHERE booking_id = ${bk.booking_id}`;
                        if (emiSchedules.length > 0) {
                            const emiIds = emiSchedules.map((e) => e.emi_id);
                            await tx `DELETE FROM emi_payment_proofs WHERE emi_id IN ${sql(emiIds)}`;
                            await tx `DELETE FROM emi_schedules WHERE booking_id = ${bk.booking_id}`;
                        }
                        try {
                            await tx `DELETE FROM booking_payment_records WHERE booking_id = ${bk.booking_id}`;
                        }
                        catch (_) { }
                        try {
                            await tx `DELETE FROM booking_invoices WHERE booking_id = ${bk.booking_id}`;
                        }
                        catch (_) { }
                        try {
                            await tx `DELETE FROM buyback_applications WHERE booking_id = ${bk.booking_id}`;
                        }
                        catch (_) { }
                        try {
                            await tx `DELETE FROM buyback_requests WHERE booking_id = ${bk.booking_id}`;
                        }
                        catch (_) { }
                        try {
                            await tx `DELETE FROM invoices WHERE booking_id = ${bk.booking_id}`;
                        }
                        catch (_) { }
                    }
                    await tx `DELETE FROM bookings WHERE user_id = ${uid}`;
                }
            }
            catch (_) { }
            try {
                await tx `DELETE FROM invoices WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `UPDATE bookings SET associate_user_id = NULL WHERE associate_user_id = ${uid}`;
            }
            catch (_) { }
            await tx `DELETE FROM users WHERE user_id = ${uid}`;
        }
        try {
            const actorId = Number(adminActor.admin_id || adminActor.id) || 1;
            const actorName = String(adminActor.full_name || adminActor.username || "Admin");
            await tx `
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
        }
        catch (auditErr) {
            console.warn('[ProfileCleanupService] Audit log write warning:', auditErr.message);
        }
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
export async function deleteCustomerProfile(customerId, adminActor = { admin_id: 1, full_name: "Admin" }) {
    const rawId = String(customerId || "").trim();
    if (!rawId) {
        const err = new Error("Customer ID is required");
        err.statusCode = 400;
        throw err;
    }
    const numId = !isNaN(Number(rawId)) ? Number(rawId) : 0;
    const [targetUser] = await sql `
    SELECT user_id, member_id, full_name, email, mobile_no, pan_number, aadhar_number, user_type
    FROM users
    WHERE (user_id = ${numId} OR member_id = ${rawId})
      AND LOWER(user_type::text) = 'customer'
    LIMIT 1
  `;
    const uid = targetUser?.user_id || (numId > 0 ? numId : 0);
    const mobile = targetUser?.mobile_no ? String(targetUser.mobile_no).trim() : null;
    const pan = targetUser?.pan_number ? String(targetUser.pan_number).trim().toUpperCase() : null;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
    const submissions = await sql `
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
        const err = new Error("Customer not found");
        err.statusCode = 404;
        throw err;
    }
    const resolvedName = targetUser?.full_name || submissions[0]?.applicant_name || "Customer";
    const submissionIds = submissions.map((s) => s.id).filter(Boolean);
    const filesToClean = [];
    const fileObjectsToClean = [];
    for (const s of submissions) {
        if (s.photo_first_applicant_url)
            filesToClean.push(s.photo_first_applicant_url);
        if (s.photo_co_applicant_url)
            filesToClean.push(s.photo_co_applicant_url);
        if (s.signature_sole_first_applicant_url)
            filesToClean.push(s.signature_sole_first_applicant_url);
        if (s.signature_co_applicant_url)
            filesToClean.push(s.signature_co_applicant_url);
        if (s.signature_authorized_signatory_url)
            filesToClean.push(s.signature_authorized_signatory_url);
    }
    if (uid > 0) {
        try {
            const userDocs = await sql `
        SELECT file_path, cloudinary_public_id FROM user_documents WHERE user_id = ${uid}
      `;
            userDocs.forEach((d) => {
                fileObjectsToClean.push({ url: d.file_path, publicId: d.cloudinary_public_id });
            });
        }
        catch (_) { }
        try {
            const [userPhoto] = await sql `
        SELECT profile_photo FROM users WHERE user_id = ${uid}
      `;
            if (userPhoto?.profile_photo)
                filesToClean.push(userPhoto.profile_photo);
        }
        catch (_) { }
    }
    await sql.begin(async (tx) => {
        if (submissionIds.length > 0) {
            try {
                await tx `DELETE FROM customer_nominees WHERE submission_id IN ${sql(submissionIds)}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM customer_enrollment_submissions WHERE id IN ${sql(submissionIds)}`;
            }
            catch (_) { }
        }
        if (uid > 0) {
            try {
                await tx `DELETE FROM customer_nominees WHERE submission_id IN (SELECT id FROM customer_enrollment_submissions WHERE user_id = ${uid})`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM customer_enrollment_submissions WHERE user_id = ${uid}`;
            }
            catch (_) { }
        }
        if (uid > 0) {
            try {
                await tx `DELETE FROM user_addresses WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_bank_details WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_nominees WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_kyc_profiles WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_documents WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_device_tokens WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM wallet_transactions WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM user_wallets WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM wallets WHERE user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM referral_registrations WHERE referred_user_id = ${uid}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM otp_log WHERE reference_id = ${String(uid)} OR (${Boolean(mobile)} AND mobile_no = ${mobile || ''}) OR (${Boolean(mobile)} AND mobile = ${mobile || ''})`;
            }
            catch (_) { }
            try {
                const bookings = await tx `SELECT booking_id, plot_id FROM bookings WHERE user_id = ${uid}`;
                if (bookings.length > 0) {
                    const plotIds = bookings.map((b) => b.plot_id).filter(Boolean);
                    if (plotIds.length > 0) {
                        await tx `UPDATE plots SET plot_status = 'Vacant'::plot_status_enum, is_booked = FALSE, updated_at = NOW() WHERE plot_id IN ${sql(plotIds)}`;
                    }
                    for (const bk of bookings) {
                        const emiSchedules = await tx `SELECT emi_id FROM emi_schedules WHERE booking_id = ${bk.booking_id}`;
                        if (emiSchedules.length > 0) {
                            const emiIds = emiSchedules.map((e) => e.emi_id);
                            await tx `DELETE FROM emi_payment_proofs WHERE emi_id IN ${sql(emiIds)}`;
                            await tx `DELETE FROM emi_schedules WHERE booking_id = ${bk.booking_id}`;
                        }
                        try {
                            await tx `DELETE FROM booking_payment_records WHERE booking_id = ${bk.booking_id}`;
                        }
                        catch (_) { }
                        try {
                            await tx `DELETE FROM booking_invoices WHERE booking_id = ${bk.booking_id}`;
                        }
                        catch (_) { }
                        try {
                            await tx `DELETE FROM buyback_applications WHERE booking_id = ${bk.booking_id}`;
                        }
                        catch (_) { }
                        try {
                            await tx `DELETE FROM buyback_requests WHERE booking_id = ${bk.booking_id}`;
                        }
                        catch (_) { }
                        try {
                            await tx `DELETE FROM invoices WHERE booking_id = ${bk.booking_id}`;
                        }
                        catch (_) { }
                    }
                    await tx `DELETE FROM bookings WHERE user_id = ${uid}`;
                }
            }
            catch (_) { }
            try {
                await tx `DELETE FROM invoices WHERE user_id = ${uid}`;
            }
            catch (_) { }
            await tx `DELETE FROM users WHERE user_id = ${uid}`;
        }
        try {
            const actorId = Number(adminActor.admin_id || adminActor.id) || 1;
            const actorName = String(adminActor.full_name || adminActor.username || "Admin");
            await tx `
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
        }
        catch (auditErr) {
            console.warn('[ProfileCleanupService] Customer audit log warning:', auditErr.message);
        }
    });
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
export async function deleteInvestorProfile(investorId, adminActor = { admin_id: 1, full_name: "Admin" }) {
    const rawId = String(investorId || "").trim();
    if (!rawId) {
        const err = new Error("Investor ID is required");
        err.statusCode = 400;
        throw err;
    }
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
    let targetInvestorId = null;
    let targetEnrollmentId = isUuid ? rawId : null;
    if (isUuid) {
        try {
            const [enrollment] = await sql `SELECT id, investor_id FROM investor_enrollments WHERE id = ${rawId}`;
            if (enrollment) {
                targetInvestorId = enrollment.investor_id || null;
            }
        }
        catch (_) { }
    }
    else {
        targetInvestorId = Number(rawId);
    }
    const filesToClean = [];
    const fileObjectsToClean = [];
    if (targetInvestorId) {
        try {
            const docs = await sql `SELECT file_url FROM investor_documents WHERE investor_id = ${targetInvestorId}`;
            docs.forEach((d) => { if (d.file_url)
                filesToClean.push(d.file_url); });
        }
        catch (_) { }
        try {
            const [invUser] = await sql `SELECT profile_picture_url FROM investor_users WHERE id = ${targetInvestorId}`;
            if (invUser?.profile_picture_url)
                filesToClean.push(invUser.profile_picture_url);
        }
        catch (_) { }
        try {
            const deposits = await sql `SELECT payment_receipt_url FROM investor_deposits WHERE investor_id = ${targetInvestorId}`;
            deposits.forEach((d) => { if (d.payment_receipt_url)
                filesToClean.push(d.payment_receipt_url); });
        }
        catch (_) { }
        try {
            const enrolls = await sql `SELECT applicant_photo_url, signature_url FROM investor_enrollments WHERE investor_id = ${targetInvestorId}`;
            enrolls.forEach((e) => {
                if (e.applicant_photo_url)
                    filesToClean.push(e.applicant_photo_url);
                if (e.signature_url)
                    filesToClean.push(e.signature_url);
            });
        }
        catch (_) { }
    }
    await sql.begin(async (tx) => {
        if (targetInvestorId) {
            try {
                await tx `DELETE FROM investors WHERE user_id = ${targetInvestorId} OR id = ${targetInvestorId}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM investor_deposits WHERE investor_id = ${targetInvestorId}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM investor_documents WHERE investor_id = ${targetInvestorId}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM investor_notifications WHERE investor_id = ${targetInvestorId}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM investor_settlement_preferences WHERE investor_id = ${targetInvestorId}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM settlement_change_requests WHERE investor_id = ${targetInvestorId}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM investor_transactions WHERE investor_id = ${targetInvestorId}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM investor_withdrawals WHERE investor_id = ${targetInvestorId}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM investor_wallet WHERE investor_id = ${targetInvestorId}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM investor_enrollments WHERE investor_id = ${targetInvestorId}`;
            }
            catch (_) { }
            try {
                await tx `DELETE FROM investor_users WHERE id = ${targetInvestorId}`;
            }
            catch (_) { }
        }
        if (targetEnrollmentId) {
            try {
                await tx `DELETE FROM investor_enrollments WHERE id = ${targetEnrollmentId}`;
            }
            catch (_) { }
        }
        try {
            const actorId = Number(adminActor.admin_id || adminActor.id) || 1;
            const actorName = String(adminActor.full_name || adminActor.username || "Admin");
            await tx `
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
        }
        catch (_) { }
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
