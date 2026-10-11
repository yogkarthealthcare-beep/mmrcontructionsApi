/**
 * MMR Construction & Developers Pvt. Ltd.
 * Admin Attribution Tools (Phase 2)
 *
 * Endpoints:
 * 1. PATCH /api/admin/users/:id/referrer
 * 2. PATCH /api/admin/bookings/:id/attribution
 * 3. POST /api/admin/referrals/bulk-resolve
 */

import express from 'express';
import sql from '../db.js';
import { verifyAdminToken, role } from '../middleware/auth.middleware.js';

const router = express.Router();

function ok(res, data = null, message = 'Success', extra = {}) {
  return res.json({ success: true, message, data, ...extra });
}

function err(res, message = 'Error', code = 400) {
  return res.status(code).json({ success: false, message });
}

function escapeCsvCell(val) {
  if (val === null || val === undefined) return '""';
  let s = String(val).replace(/"/g, '""');
  if (/^[=+\-@]/.test(s)) {
    s = "'" + s;
  }
  return `"${s}"`;
}

/**
 * 1. PATCH /api/admin/users/:id/referrer
 * Admin assigns or changes referrer for a Customer.
 * Note: Historical bookings snapshot is NOT modified.
 */
router.patch('/admin/users/:id/referrer', verifyAdminToken, role('SuperAdmin', 'Admin'), async (req, res) => {
  try {
    const targetUserId = Number(req.params.id);
    const { referrer_user_id, referrer_member_id, reason } = req.body || {};

    if (!reason || !String(reason).trim()) {
      return err(res, 'Reason is mandatory for changing customer referrer.', 400);
    }

    const [targetUser] = await sql`
      SELECT user_id, member_id, full_name, user_type, referred_by_user_id, referred_by_source
      FROM users WHERE user_id = ${targetUserId}
    `;

    if (!targetUser) {
      return err(res, 'Customer not found.', 404);
    }

    if (targetUser.user_type !== 'Customer') {
      return err(res, 'Referrer can only be assigned to Customer accounts.', 400);
    }

    let newReferrer = null;
    if (referrer_user_id || referrer_member_id) {
      const [refRow] = await sql`
        SELECT user_id, member_id, full_name, user_type, account_status
        FROM users
        WHERE (user_id = ${Number(referrer_user_id || 0)} OR UPPER(member_id) = ${String(referrer_member_id || '').trim().toUpperCase()})
        LIMIT 1
      `;

      if (!refRow) {
        return err(res, 'Referrer user not found.', 404);
      }

      if (refRow.user_id === targetUserId) {
        return err(res, 'Customer cannot be referred by themselves.', 400);
      }

      if (!['Associate', 'Team Member'].includes(refRow.user_type)) {
        return err(res, 'Referrer must be an Associate or Team Member.', 400);
      }

      if (!['Active', 'Approved'].includes(refRow.account_status)) {
        return err(res, 'Referrer account must be active.', 400);
      }

      newReferrer = refRow;
    }

    const newReferrerId = newReferrer ? newReferrer.user_id : null;
    const newSource = newReferrer ? 'ADMIN_ASSIGNED' : 'DIRECT_SIGNUP';

    const [updatedUser] = await sql`
      UPDATE users SET
        referred_by_user_id = ${newReferrerId},
        referred_by_source = ${newSource},
        referred_by_set_at = NOW(),
        updated_at = NOW()
      WHERE user_id = ${targetUserId}
      RETURNING user_id, member_id, full_name, user_type, referred_by_user_id, referred_by_source, referred_by_set_at
    `;

    // Audit log
    await sql`
      INSERT INTO audit_log (
        actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value
      ) VALUES (
        'Admin', ${req.admin.admin_id}, ${req.admin.full_name}, 'AttributionManagement', 'AdminReferrerChanged', 'users', ${targetUserId},
        ${JSON.stringify({
          before: {
            referred_by_user_id: targetUser.referred_by_user_id,
            referred_by_source: targetUser.referred_by_source
          },
          after: {
            referred_by_user_id: newReferrerId,
            referred_by_source: newSource
          },
          reason: String(reason).trim()
        })}
      )
    `;

    return ok(res, updatedUser, 'Customer referrer updated successfully. Historical bookings snapshot remains preserved.');
  } catch (e) {
    return err(res, e.message);
  }
});

/**
 * 2. PATCH /api/admin/bookings/:id/attribution
 * Admin corrects or resolves sales attribution on a specific booking record.
 */
router.patch('/admin/bookings/:id/attribution', verifyAdminToken, role('SuperAdmin', 'Admin'), async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const {
      booked_by_user_id,
      sold_by_user_id,
      associate_user_id,
      booking_type,
      associate_approval_status,
      reason
    } = req.body || {};

    if (!reason || !String(reason).trim()) {
      return err(res, 'Reason is mandatory for updating booking sales attribution.', 400);
    }

    const [booking] = await sql`SELECT * FROM bookings WHERE booking_id = ${bookingId}`;
    if (!booking) {
      return err(res, 'Booking not found.', 404);
    }

    const allowedBookingTypes = [
      'CUSTOMER_SELF', 'SELF_PURCHASE', 'ON_BEHALF_BY_TEAM_MEMBER',
      'ON_BEHALF_BY_ASSOCIATE', 'DIRECT_PURCHASE', 'UNKNOWN_HISTORICAL'
    ];
    if (booking_type && !allowedBookingTypes.includes(booking_type)) {
      return err(res, `Invalid booking_type. Allowed: ${allowedBookingTypes.join(', ')}`, 400);
    }

    const allowedApprovals = ['Pending', 'Approved', 'Rejected', 'NotRequired', 'AutoApproved_CreatedByAssociate'];
    if (associate_approval_status && !allowedApprovals.includes(associate_approval_status)) {
      return err(res, `Invalid associate_approval_status. Allowed: ${allowedApprovals.join(', ')}`, 400);
    }

    // Validate users if provided
    if (booked_by_user_id !== undefined && booked_by_user_id !== null) {
      const [u] = await sql`SELECT user_id FROM users WHERE user_id = ${Number(booked_by_user_id)}`;
      if (!u) return err(res, 'Booked by user not found.', 404);
    }

    if (sold_by_user_id !== undefined && sold_by_user_id !== null) {
      const [u] = await sql`SELECT user_id, user_type FROM users WHERE user_id = ${Number(sold_by_user_id)}`;
      if (!u) return err(res, 'Sold by user not found.', 404);
    }

    if (associate_user_id !== undefined && associate_user_id !== null) {
      const [u] = await sql`SELECT user_id, user_type FROM users WHERE user_id = ${Number(associate_user_id)}`;
      if (!u) return err(res, 'Associate user not found.', 404);
      if (u.user_type !== 'Associate') return err(res, 'Associate user must have user_type Associate.', 400);
    }

    const finalBookedBy = booked_by_user_id !== undefined ? (booked_by_user_id ? Number(booked_by_user_id) : null) : booking.booked_by_user_id;
    const finalSoldBy = sold_by_user_id !== undefined ? (sold_by_user_id ? Number(sold_by_user_id) : null) : booking.sold_by_user_id;
    const finalAssociate = associate_user_id !== undefined ? (associate_user_id ? Number(associate_user_id) : null) : booking.associate_user_id;
    const finalBookingType = booking_type || booking.booking_type;
    const finalApprovalStatus = associate_approval_status || booking.associate_approval_status;

    const [updatedBooking] = await sql`
      UPDATE bookings SET
        booked_by_user_id = ${finalBookedBy},
        sold_by_user_id = ${finalSoldBy},
        associate_user_id = ${finalAssociate},
        booking_type = ${finalBookingType},
        associate_approval_status = ${finalApprovalStatus},
        updated_at = NOW()
      WHERE booking_id = ${bookingId}
      RETURNING booking_id, booking_serial, booked_by_user_id, sold_by_user_id, associate_user_id, booking_type, associate_approval_status
    `;

    // Audit log
    await sql`
      INSERT INTO audit_log (
        actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value
      ) VALUES (
        'Admin', ${req.admin.admin_id}, ${req.admin.full_name}, 'AttributionManagement', 'AdminBookingAttributionChanged', 'bookings', ${bookingId},
        ${JSON.stringify({
          before: {
            booked_by_user_id: booking.booked_by_user_id,
            sold_by_user_id: booking.sold_by_user_id,
            associate_user_id: booking.associate_user_id,
            booking_type: booking.booking_type,
            associate_approval_status: booking.associate_approval_status
          },
          after: {
            booked_by_user_id: finalBookedBy,
            sold_by_user_id: finalSoldBy,
            associate_user_id: finalAssociate,
            booking_type: finalBookingType,
            associate_approval_status: finalApprovalStatus
          },
          reason: String(reason).trim()
        })}
      )
    `;

    return ok(res, updatedBooking, 'Booking sales attribution updated successfully.');
  } catch (e) {
    return err(res, e.message);
  }
});

/**
function escapeCsvCell(val) {
  if (val === null || val === undefined) return '""';
  let s = String(val).replace(/"/g, '""');
  if (/^[=+\-@]/.test(s)) {
    s = "'" + s;
  }
  return `"${s}"`;
}

/**
 * 3. POST /api/admin/referrals/bulk-resolve
 * Batch resolves ambiguous/missing customer referrers.
 * Dry run mode enabled by default (dry_run: true).
 * Mandatory reason, max 1000 rows cap, server forces ADMIN_ASSIGNED.
 */
router.post('/admin/referrals/bulk-resolve', verifyAdminToken, role('SuperAdmin'), async (req, res) => {
  try {
    const reason = req.body.reason ? String(req.body.reason).trim() : '';
    if (!reason) {
      return err(res, 'Reason is mandatory for bulk referral resolution.', 400);
    }

    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) {
      return err(res, 'No referral records provided. Expected array of referral rows.', 400);
    }

    if (rows.length > 1000) {
      return err(res, 'Maximum 1000 rows allowed per bulk-resolve request.', 400);
    }

    const isDryRun = req.body.dry_run !== false; // Default true
    const allowOverride = Boolean(req.body.override);

    const results = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const customerCode = String(row.customer_member_id || '').trim().toUpperCase();
      const customerId = row.customer_id || row.customer_user_id ? Number(row.customer_id || row.customer_user_id) : null;
      const referrerCode = String(row.referrer_member_id || '').trim().toUpperCase();
      const referrerId = row.referrer_id || row.referrer_user_id ? Number(row.referrer_id || row.referrer_user_id) : null;
      const rowReason = String(row.reason_note || reason).trim();
      const rowOverride = Boolean(row.override || allowOverride);

      if (!customerCode && !customerId) {
        errors.push({ row_index: i, error_code: 'MISSING_CUSTOMER', error: 'Either customer_member_id or customer_id is required.' });
        continue;
      }
      if (!referrerCode && !referrerId) {
        errors.push({ row_index: i, customer_member_id: customerCode, error_code: 'MISSING_REFERRER', error: 'Either referrer_member_id or referrer_id is required.' });
        continue;
      }

      const [customer] = await sql`
        SELECT user_id, member_id, full_name, user_type, referred_by_user_id, referred_by_source
        FROM users
        WHERE (UPPER(member_id) = ${customerCode} OR user_id = ${customerId || 0})
        LIMIT 1
      `;

      if (!customer) {
        errors.push({ row_index: i, customer_member_id: customerCode, error_code: 'CUSTOMER_NOT_FOUND', error: 'Customer not found.' });
        continue;
      }

      if (customer.user_type !== 'Customer') {
        errors.push({ row_index: i, customer_member_id: customer.member_id, error_code: 'NOT_A_CUSTOMER', error: 'Target user is not a Customer.' });
        continue;
      }

      if (customer.referred_by_user_id !== null && !rowOverride) {
        errors.push({
          row_index: i,
          customer_member_id: customer.member_id,
          error_code: 'ALREADY_ATTRIBUTED',
          error: 'Customer already has a referrer assigned. Use override: true to reassign.'
        });
        continue;
      }

      const [referrer] = await sql`
        SELECT user_id, member_id, full_name, user_type, account_status
        FROM users
        WHERE (UPPER(member_id) = ${referrerCode} OR user_id = ${referrerId || 0})
        LIMIT 1
      `;

      if (!referrer) {
        errors.push({ row_index: i, referrer_member_id: referrerCode, error_code: 'REFERRER_NOT_FOUND', error: 'Referrer not found.' });
        continue;
      }

      if (!['Associate', 'Team Member'].includes(referrer.user_type)) {
        errors.push({ row_index: i, referrer_member_id: referrer.member_id, error_code: 'INVALID_REFERRER_ROLE', error: 'Referrer must be an Associate or Team Member.' });
        continue;
      }

      if (!['Active', 'Approved'].includes(referrer.account_status)) {
        errors.push({ row_index: i, referrer_member_id: referrer.member_id, error_code: 'REFERRER_INACTIVE', error: 'Referrer account is not active.' });
        continue;
      }

      if (customer.user_id === referrer.user_id) {
        errors.push({ row_index: i, customer_member_id: customer.member_id, error_code: 'SELF_REFERRAL', error: 'Customer cannot be their own referrer.' });
        continue;
      }

      if (!isDryRun) {
        await sql`
          UPDATE users SET
            referred_by_user_id = ${referrer.user_id},
            referred_by_source = 'ADMIN_ASSIGNED',
            referred_by_set_at = NOW(),
            updated_at = NOW()
          WHERE user_id = ${customer.user_id}
        `;

        await sql`
          INSERT INTO audit_log (
            actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value
          ) VALUES (
            'Admin', ${req.admin.admin_id}, ${req.admin.full_name}, 'AttributionManagement', 'BulkReferralResolved', 'users', ${customer.user_id},
            ${JSON.stringify({
              customer_member_id: customer.member_id,
              referrer_member_id: referrer.member_id,
              reason: rowReason
            })}
          )
        `;
      }

      results.push({
        row_index: i,
        customer_id: customer.user_id,
        customer_member_id: customer.member_id,
        customer_name: customer.full_name,
        assigned_referrer_id: referrer.user_id,
        assigned_referrer_member_id: referrer.member_id,
        assigned_referrer_name: referrer.full_name,
        status: isDryRun ? 'VALID_DRY_RUN' : 'RESOLVED'
      });
    }

    // Build CSV export
    let csv = 'Row Index,Status,Customer ID,Customer Member ID,Customer Name,Referrer Member ID,Referrer Name,Error Code,Error Message\n';
    for (const r of results) {
      csv += [
        r.row_index,
        escapeCsvCell(r.status),
        r.customer_id,
        escapeCsvCell(r.customer_member_id),
        escapeCsvCell(r.customer_name),
        escapeCsvCell(r.assigned_referrer_member_id),
        escapeCsvCell(r.assigned_referrer_name),
        '""',
        '""'
      ].join(',') + '\n';
    }
    for (const e of errors) {
      csv += [
        e.row_index,
        '"ERROR"',
        '""',
        escapeCsvCell(e.customer_member_id || ''),
        '""',
        escapeCsvCell(e.referrer_member_id || ''),
        '""',
        escapeCsvCell(e.error_code),
        escapeCsvCell(e.error)
      ].join(',') + '\n';
    }

    if (req.query.format === 'csv' || req.headers.accept?.includes('text/csv')) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="bulk_resolve_report.csv"');
      return res.status(200).send(csv);
    }

    return ok(res, {
      dry_run: isDryRun,
      total_submitted: rows.length,
      success_count: results.length,
      error_count: errors.length,
      results,
      errors,
      csv
    }, isDryRun ? 'Bulk resolve dry-run validation complete. No changes made.' : 'Bulk resolve executed successfully.');
  } catch (e) {
    return err(res, e.message);
  }
});

export default router;
