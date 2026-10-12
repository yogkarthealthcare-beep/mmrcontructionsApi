/**
 * MMR Construction & Developers Pvt. Ltd.
 * Canonical Commission Service (Phase 2 & M1 Fix)
 *
 * Single Source of Truth for:
 * 1. Team Member / Associate seller attribution strictly via bookings.sold_by_user_id
 * 2. MMR 10-Member Team Plan integer-paise math:
 *    - 10% pool (or admin configured %)
 *    - 50% seller direct payout
 *    - 50% split equally among remaining participants (team members + associate leader)
 *    - Integer-exact paise handling with remainder assigned to Associate Leader (or seller)
 *    - Undistributed retention logged when Associate sells with 0 team members
 * 3. Canonical event_key idempotency preventing duplicate commission payouts across all routes
 * 4. Safe non-destructive cancellation (Pending -> Cancelled, Approved/Paid -> needs_review)
 * 5. Reversal transactions and SuperAdmin audits
 */

import sql from '../db.js';

/**
 * Pure math helper calculating commission distribution in integer paise.
 * Invariant: sum(all payouts) + undistributedAmount === totalPoolAmount.
 */
export function calculateCommissionDistribution({
  baseAmount,
  totalPoolRate = 10,
  sellerPoolShare = 50,
  teamPoolShare = 50,
  participantsCount = 0,
  isTeamMemberSeller = false,
}) {
  const principal = Math.max(Number(baseAmount || 0), 0);
  if (!(principal > 0)) {
    return {
      baseAmount: 0,
      poolAmount: 0,
      sellerAmount: 0,
      baseSellerAmount: 0,
      sellerRemainderAmount: 0,
      remainingPoolAmount: 0,
      eachShareAmount: 0,
      associateShareAmount: 0,
      associateRemainderAmount: 0,
      undistributedAmount: 0,
      totalDistributedAmount: 0,
      totalPoolRate,
      sellerPoolShare,
      teamPoolShare,
      participantsCount,
      isTeamMemberSeller,
    };
  }

  // Convert to integer paise to eliminate floating point imprecision
  const baseInPaise = Math.round(principal * 100);
  const poolInPaise = Math.round((baseInPaise * totalPoolRate) / 100);
  const sellerInPaise = Math.round((poolInPaise * sellerPoolShare) / 100);
  const remainingInPaise = poolInPaise - sellerInPaise;

  let eachInPaise = 0;
  let associateRemainderInPaise = 0;
  let sellerRemainderInPaise = 0;
  let undistributedInPaise = 0;

  if (participantsCount === 0) {
    // If seller is Associate and has 0 active team members, remaining 50% pool stays with company
    undistributedInPaise = remainingInPaise;
  } else {
    eachInPaise = Math.floor(remainingInPaise / participantsCount);
    const distributed = eachInPaise * participantsCount;
    const remainderInPaise = remainingInPaise - distributed;

    if (isTeamMemberSeller) {
      // Associate Leader is one of the participants and absorbs the remainder paise
      associateRemainderInPaise = remainderInPaise;
    } else {
      // Seller is the Associate Leader; Seller absorbs the remainder paise
      sellerRemainderInPaise = remainderInPaise;
    }
  }

  const finalSellerInPaise = sellerInPaise + sellerRemainderInPaise;
  const associateParticipantInPaise =
    isTeamMemberSeller && participantsCount > 0
      ? eachInPaise + associateRemainderInPaise
      : 0;
  const otherParticipantsInPaise = isTeamMemberSeller
    ? eachInPaise * Math.max(participantsCount - 1, 0)
    : eachInPaise * participantsCount;

  const totalDistributedInPaise =
    finalSellerInPaise +
    (isTeamMemberSeller && participantsCount > 0 ? associateParticipantInPaise : 0) +
    otherParticipantsInPaise;

  // Strict invariant: sum(all payouts) + undistributed === pool
  if (totalDistributedInPaise + undistributedInPaise !== poolInPaise) {
    throw new Error(
      `Commission math discrepancy: distributed (${totalDistributedInPaise}) + undistributed (${undistributedInPaise}) !== pool (${poolInPaise})`
    );
  }

  return {
    baseAmount: principal,
    poolAmount: Number((poolInPaise / 100).toFixed(2)),
    sellerAmount: Number((finalSellerInPaise / 100).toFixed(2)),
    baseSellerAmount: Number((sellerInPaise / 100).toFixed(2)),
    sellerRemainderAmount: Number((sellerRemainderInPaise / 100).toFixed(2)),
    remainingPoolAmount: Number((remainingInPaise / 100).toFixed(2)),
    eachShareAmount: Number((eachInPaise / 100).toFixed(2)),
    associateShareAmount:
      isTeamMemberSeller && participantsCount > 0
        ? Number((associateParticipantInPaise / 100).toFixed(2))
        : 0,
    associateRemainderAmount: Number((associateRemainderInPaise / 100).toFixed(2)),
    undistributedAmount: Number((undistributedInPaise / 100).toFixed(2)),
    totalDistributedAmount: Number((totalDistributedInPaise / 100).toFixed(2)),
    totalPoolRate,
    sellerPoolShare,
    teamPoolShare,
    participantsCount,
    isTeamMemberSeller,
  };
}

/**
 * Standardize canonical event_key to ensure idempotency across diverse routes
 */
export function buildCanonicalEventKey({ bookingId, sourceType, sourceId, eventKey }) {
  if (eventKey && String(eventKey).trim()) {
    return String(eventKey).trim();
  }
  const cleanSourceId = String(sourceId || '').trim();
  const sType = String(sourceType || '').trim();

  if (sType === 'FullPayment') {
    return `full:${bookingId}`;
  }
  if (sType === 'InitialPayment' || sType === 'BookingAdvance') {
    return `adv:${bookingId}`;
  }
  if (sType === 'EmiPayment') {
    const emiId = cleanSourceId.replace(/^emi-?/i, '');
    return `emi:${emiId || bookingId}`;
  }
  if (sType === 'PartialPayment') {
    const partRef = cleanSourceId.replace(/^partial-?/i, '');
    return `part:${partRef || bookingId}`;
  }
  if (sType === 'Manual') {
    const manualRef = cleanSourceId.replace(/^manual-?/i, '');
    return `manual:${bookingId}:${manualRef || 'admin'}`;
  }
  return `${sType.toLowerCase()}:${bookingId}:${cleanSourceId || 'default'}`;
}

/**
 * Ensure canonical schema additions exist in database (idempotent helper)
 */
export async function ensureCommissionSchemaExtensions(db = sql) {
  await db`
    ALTER TABLE commission_source_events
    ADD COLUMN IF NOT EXISTS event_key TEXT,
    ADD COLUMN IF NOT EXISTS undistributed_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS settings_snapshot JSONB
  `.catch(() => {});

  await db`
    ALTER TABLE commission_transactions
    ADD COLUMN IF NOT EXISTS event_key TEXT,
    ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS review_reason TEXT
  `.catch(() => {});

  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_events_booking_event_key
    ON commission_source_events(booking_id, event_key)
    WHERE event_key IS NOT NULL
  `.catch(() => {});

  await db`
    CREATE INDEX IF NOT EXISTS idx_commission_tx_booking_review
    ON commission_transactions(related_booking_id, needs_review)
  `.catch(() => {});
}

/**
 * Fetch snapshot of active commission engine settings
 */
export async function getCommissionEngineSnapshot(db = sql) {
  const [settingsRow] = await db`
    SELECT settings.*, admin.full_name AS updated_by
    FROM commission_engine_settings settings
    LEFT JOIN admin_users admin ON admin.admin_id = settings.updated_by_admin_id
    WHERE settings.id = 1
  `;
  if (!settingsRow) {
    return {
      is_active: true,
      commission_model: 'FlatTeam',
      version: 1,
      total_commission_percentage: 10,
      seller_percentage: 50,
      team_pool_percentage: 50,
      eligibility_rules: {},
    };
  }
  return settingsRow;
}

/**
 * Centralized Commission Generation Function
 *
 * Parameters:
 * - bookingId: integer ID of the booking
 * - event: { type, key, principalAmount, sourceRef, paymentType }
 * - adminId: integer ID of approving admin (optional)
 * - db: postgres client/transaction (optional, defaults to sql)
 */
export async function generateCommissionForPayment({
  bookingId,
  event = {},
  adminId = null,
  db = null,
}) {
  const client = db || sql;
  const bId = Number(bookingId);
  if (!bId || bId <= 0) return { generated: 0, reason: "Invalid booking ID" };

  const sourceType = event.type || event.sourceType || "InitialPayment";
  const sourceId = String(event.sourceRef || event.sourceId || bId);
  const paymentType = event.paymentType || "Standard";
  const principalAmount = Number(event.principalAmount ?? event.receivedAmount ?? 0);

  if (!(principalAmount > 0)) {
    return { generated: 0, reason: "Payment principal amount must be greater than zero" };
  }

  const eventKey = buildCanonicalEventKey({
    bookingId: bId,
    sourceType,
    sourceId,
    eventKey: event.key || event.eventKey,
  });

  const runWithDb = async (tx) => {
    // 1. Transaction Advisory Lock on booking
    await tx`SELECT pg_advisory_xact_lock(${bId})`;
    await ensureCommissionSchemaExtensions(tx);

    // 2. Fetch booking and plot data
    const [booking] = await tx`
      SELECT b.booking_id, b.booking_serial, b.booking_status, b.booking_type,
             b.user_id, b.booked_by_user_id, b.sold_by_user_id, b.associate_user_id,
             b.payment_type, b.advance_amount,
             p.plot_id, p.plot_area, p.area_unit, p.base_price, p.plot_number,
             s.site_name
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      WHERE b.booking_id = ${bId}
    `;

    if (!booking) return { generated: 0, reason: "Booking not found" };

    // 3. Guards: Self Purchase & Company Direct
    if (booking.booking_type === 'SELF_PURCHASE') {
      const allowSelfPurchaseCommission = process.env.COMMISSION_ON_SELF_PURCHASE === 'true';
      if (!allowSelfPurchaseCommission) {
        return { generated: 0, reason: "Self-purchase booking (commission disabled)" };
      }
    }

    if (!booking.sold_by_user_id) {
      // Company Direct sale - no commission generated
      return { generated: 0, reason: "No seller attributed (Company Direct)" };
    }

    if (['Cancelled', 'Rejected'].includes(booking.booking_status)) {
      return { generated: 0, reason: "Booking is cancelled or rejected" };
    }

    // 4. Idempotency Check: check both canonical event_key AND legacy source_id
    const [existingEvent] = await tx`
      SELECT event_id, event_key
      FROM commission_source_events
      WHERE booking_id = ${bId}
        AND (
          (event_key IS NOT NULL AND event_key = ${eventKey})
          OR (source_type = ${sourceType} AND source_id = ${sourceId})
        )
      LIMIT 1
    `;
    if (existingEvent) {
      return {
        generated: 0,
        reason: "Payment event already processed",
        event_id: existingEvent.event_id,
        event_key: existingEvent.event_key || eventKey,
      };
    }

    // 5. Fetch Commission Engine Settings Snapshot
    const engine = await getCommissionEngineSnapshot(tx);
    if (!engine.is_active) {
      return { generated: 0, reason: "Commission engine inactive" };
    }

    const eligibility = engine.eligibility_rules || {};
    if (Number(booking.base_price || 0) < Number(eligibility.minimum_plot_amount || 0)) {
      return { generated: 0, reason: "Plot amount below eligibility minimum" };
    }
    if (principalAmount < Number(eligibility.minimum_payment_amount || 0)) {
      return { generated: 0, reason: "Payment amount below eligibility minimum" };
    }

    // 6. Resolve Seller (Strictly sold_by_user_id, NO fallback to sponsor_user_id)
    const sellerUserId = Number(booking.sold_by_user_id);
    const [seller] = await tx`
      SELECT user_id, member_id, full_name, user_type, account_status, sponsor_user_id
      FROM users
      WHERE user_id = ${sellerUserId}
        AND user_type IN ('Associate', 'Team Member')
    `;

    if (!seller) {
      return { generated: 0, reason: "Seller associate/team member not found or invalid user type" };
    }

    if (eligibility.require_active_associate !== false && !['Active', 'Approved'].includes(seller.account_status)) {
      return { generated: 0, reason: "Seller inactive" };
    }
    if (eligibility.exclude_blacklisted !== false && seller.account_status === 'Blacklisted') {
      return { generated: 0, reason: "Seller blacklisted" };
    }

    // 7. Resolve Seller Role & Team Hierarchy
    const [tmSellerRow] = await tx`
      SELECT associate_id
      FROM team_members
      WHERE user_id = ${sellerUserId}
        AND LOWER(status) IN ('approved', 'active')
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const isTeamMemberSeller = Boolean(tmSellerRow) || seller.user_type === 'Team Member';
    const leaderUserId = isTeamMemberSeller
      ? Number(tmSellerRow?.associate_id || booking.associate_user_id || seller.sponsor_user_id || 0)
      : sellerUserId;

    // 8. Fetch Active/Eligible Team Members under leaderUserId
    const teamRows = leaderUserId
      ? await tx`
          SELECT DISTINCT tm.user_id, COALESCE(u.account_status, 'Active') AS account_status, 'Team Member' AS user_type
          FROM team_members tm
          LEFT JOIN users u ON tm.user_id = u.user_id
          WHERE tm.associate_id = ${leaderUserId}
            AND LOWER(tm.status) IN ('approved', 'active')
            AND tm.user_id IS NOT NULL
        `
      : [];

    const eligibleTeamMembers = teamRows.filter((m) => {
      if (Number(m.user_id) === sellerUserId) return false;
      const isMemberActive = ['Active', 'Approved'].includes(m.account_status);
      if (eligibility.require_active_associate !== false && !isMemberActive) return false;
      if (eligibility.exclude_blacklisted !== false && m.account_status === 'Blacklisted') return false;
      return true;
    });

    // 9. Prepare Participants (Team minus Seller)
    const remainingParticipants = [];
    if (isTeamMemberSeller) {
      // Seller is Team Member: participants = Associate Leader + other active team members
      if (leaderUserId && leaderUserId !== sellerUserId) {
        const [leaderUser] = await tx`
          SELECT user_id, account_status, user_type
          FROM users
          WHERE user_id = ${leaderUserId}
            AND user_type = 'Associate'
        `;
        const isLeaderActive = leaderUser && ['Active', 'Approved'].includes(leaderUser.account_status);
        const leaderEligible =
          leaderUser &&
          (eligibility.require_active_associate === false || isLeaderActive) &&
          (eligibility.exclude_blacklisted === false || leaderUser.account_status !== 'Blacklisted');

        if (leaderEligible) {
          remainingParticipants.push({
            user_id: leaderUserId,
            user_type: 'Associate',
            role: 'AssociateLeader',
          });
        }
      }

      for (const tm of eligibleTeamMembers) {
        remainingParticipants.push({
          user_id: Number(tm.user_id),
          user_type: 'Team Member',
          role: 'TeamMember',
        });
      }
    } else {
      // Seller is Associate Leader: participants = all active enrolled team members
      for (const tm of eligibleTeamMembers) {
        remainingParticipants.push({
          user_id: Number(tm.user_id),
          user_type: 'Team Member',
          role: 'TeamMember',
        });
      }
    }

    const participantCount = remainingParticipants.length;

    // 10. Perform Integer-Paise Math
    const totalPoolRate = Number(engine.total_commission_percentage ?? 10);
    const sellerPoolShare = Number(engine.seller_percentage ?? 50);
    const teamPoolShare = Number(engine.team_pool_percentage ?? (100 - sellerPoolShare));

    // M2 Resolution: If EMI payment, calculate commission base strictly on the principal component (excluding flat interest)
    let effectivePrincipal = principalAmount;
    if ((sourceType === 'EmiPayment' || sourceType === 'emi') && (!event.principalAmount || event.principalAmount === event.receivedAmount)) {
      const emiId = Number(sourceId);
      if (emiId > 0) {
        const [emiRow] = await tx`SELECT principal_component FROM emi_schedules WHERE emi_id = ${emiId}`;
        if (emiRow?.principal_component && Number(emiRow.principal_component) > 0) {
          effectivePrincipal = Number(emiRow.principal_component);
        }
      }
    }

    const math = calculateCommissionDistribution({
      baseAmount: effectivePrincipal,
      totalPoolRate,
      sellerPoolShare,
      teamPoolShare,
      participantsCount: participantCount,
      isTeamMemberSeller,
    });

    // 11. Insert Commission Source Event
    const currentMonth = new Date().toISOString().slice(0, 7);
    const effectiveAdminId = adminId || null;

    const [eventRow] = await tx`
      INSERT INTO commission_source_events (
        booking_id, source_type, source_id, payment_type, received_amount,
        plot_amount, plot_area_gaj, commission_model, engine_version, generated_by_admin_id,
        event_key, undistributed_amount, settings_snapshot
      ) VALUES (
        ${bId}, ${sourceType}, ${sourceId}, ${paymentType}, ${principalAmount},
        ${Number(booking.base_price || 0)}, ${Number(booking.plot_area || 0)},
        ${engine.commission_model || 'FlatTeam'}, ${engine.version || 1}, ${effectiveAdminId},
        ${eventKey}, ${math.undistributedAmount}, ${tx.json(engine)}
      )
      ON CONFLICT (booking_id, source_type, source_id) DO NOTHING
      RETURNING event_id
    `;

    if (!eventRow) {
      return { generated: 0, reason: "Payment event already processed", event_key: eventKey };
    }

    const eventId = eventRow.event_id;
    let generated = 0;
    let totalCommissionDistributed = 0;

    // 12. Direct Seller Payout Insertion
    if (math.sellerAmount > 0) {
      const sellerEffectivePercentage =
        Math.round(((totalPoolRate * sellerPoolShare) / 100) * 1000) / 1000;

      const [comm] = await tx`
        INSERT INTO commission_transactions (
          associate_user_id, related_booking_id, commission_type, gaj_sold,
          gross_amount, deduction_amount, net_amount, commission_month, commission_status,
          commission_event_id, commission_model, commission_level, commission_percentage,
          calculation_base, source_type, source_reference, engine_version,
          distribution_role, distribution_participants, seller_user_id, event_key
        ) VALUES (
          ${sellerUserId}, ${bId}, 'Direct', ${Number(booking.plot_area || 0)},
          ${math.sellerAmount}, 0, ${math.sellerAmount}, ${currentMonth}, 'Pending',
          ${eventId}, ${engine.commission_model || 'FlatTeam'}, 1, ${sellerEffectivePercentage},
          ${principalAmount}, ${sourceType}, ${sourceId}, ${engine.version || 1},
          'Seller', ${participantCount}, ${sellerUserId}, ${eventKey}
        )
        ON CONFLICT DO NOTHING
        RETURNING commission_id
      `;

      if (comm) {
        await tx`
          INSERT INTO associate_sales_tracker (associate_user_id, total_gaj_sold, total_commission_earned)
          VALUES (${sellerUserId}, ${Number(booking.plot_area || 0)}, ${math.sellerAmount})
          ON CONFLICT (associate_user_id) DO UPDATE SET
            total_gaj_sold = associate_sales_tracker.total_gaj_sold + ${Number(booking.plot_area || 0)},
            total_commission_earned = associate_sales_tracker.total_commission_earned + ${math.sellerAmount},
            updated_at = NOW()
        `;
        generated++;
        totalCommissionDistributed += math.sellerAmount;
      }
    }

    // 13. Team Participants Payout Insertion
    if (participantCount > 0 && math.remainingPoolAmount > 0) {
      const eachEffectivePercentage =
        participantCount > 0
          ? Math.round((((totalPoolRate * teamPoolShare) / 100) / participantCount) * 1000) / 1000
          : 0;

      for (const p of remainingParticipants) {
        // Associate Leader participant gets the absorbed remainder paise
        const payout =
          p.role === 'AssociateLeader' && math.associateShareAmount > 0
            ? math.associateShareAmount
            : math.eachShareAmount;

        if (!(payout > 0)) continue;

        const [comm] = await tx`
          INSERT INTO commission_transactions (
            associate_user_id, related_booking_id, commission_type, gaj_sold,
            gross_amount, deduction_amount, net_amount, commission_month, commission_status,
            commission_event_id, commission_model, commission_level, commission_percentage,
            calculation_base, source_type, source_reference, engine_version,
            distribution_role, distribution_participants, seller_user_id, event_key
          ) VALUES (
            ${p.user_id}, ${bId}, 'Upline', 0,
            ${payout}, 0, ${payout}, ${currentMonth}, 'Pending',
            ${eventId}, ${engine.commission_model || 'FlatTeam'}, ${p.role === 'AssociateLeader' ? 2 : 3}, ${eachEffectivePercentage},
            ${principalAmount}, ${sourceType}, ${sourceId}, ${engine.version || 1},
            ${p.role}, ${participantCount}, ${sellerUserId}, ${eventKey}
          )
          ON CONFLICT DO NOTHING
          RETURNING commission_id
        `;

        if (comm) {
          await tx`
            INSERT INTO associate_sales_tracker (associate_user_id, total_gaj_sold, total_commission_earned)
            VALUES (${p.user_id}, 0, ${payout})
            ON CONFLICT (associate_user_id) DO UPDATE SET
              total_commission_earned = associate_sales_tracker.total_commission_earned + ${payout},
              updated_at = NOW()
          `;
          generated++;
          totalCommissionDistributed += payout;
        }
      }
    }

    return {
      generated,
      total_commission: Number(totalCommissionDistributed.toFixed(2)),
      model: engine.commission_model || 'FlatTeam',
      version: engine.version || 1,
      event_id: eventId,
      event_key: eventKey,
      seller_user_id: sellerUserId,
      seller_commission: math.sellerAmount,
      team_members_count: participantCount,
      is_team_member_seller: isTeamMemberSeller,
      leader_user_id: leaderUserId,
      undistributed_amount: math.undistributedAmount,
    };
  };

  if (db) {
    return await runWithDb(db);
  }
  return await sql.begin(runWithDb);
}

/**
 * Safe Cancellation Handler for Bookings (Task 5)
 * - Marks all 'Pending' commissions as 'Cancelled'
 * - Flags 'Approved' or 'Paid' commissions for Admin Review (needs_review = true)
 * - Never deletes rows or performs automatic wallet clawbacks
 */
export async function cancelBookingCommissions(db, { bookingId, reason = 'Booking cancelled/rejected' }) {
  const client = db || sql;
  const bId = Number(bookingId);
  if (!bId) return { cancelledCount: 0, flaggedCount: 0 };

  const cancelledRows = await client`
    UPDATE commission_transactions
    SET commission_status = 'Cancelled',
        notes = COALESCE(notes || '; ', '') || 'Cancelled on booking status change: ' || ${reason},
        updated_at = NOW()
    WHERE related_booking_id = ${bId}
      AND commission_status = 'Pending'
    RETURNING commission_id
  `;

  const flaggedRows = await client`
    UPDATE commission_transactions
    SET needs_review = TRUE,
        review_reason = 'Booking cancelled after commission approved/paid: ' || ${reason},
        updated_at = NOW()
    WHERE related_booking_id = ${bId}
      AND commission_status IN ('Approved', 'Paid')
    RETURNING commission_id
  `;

  return {
    cancelledCount: cancelledRows.length,
    flaggedCount: flaggedRows.length,
  };
}

/**
 * Manual Reversal Handler (SuperAdmin Only, Task 5)
 */
export async function reverseCommissionTransaction(db, { commissionId, adminId, reason }) {
  const client = db || sql;
  const cId = Number(commissionId);
  if (!cId) throw new Error("Invalid commission ID");
  if (!reason || !String(reason).trim()) throw new Error("Reversal reason is mandatory");

  const [orig] = await client`
    SELECT * FROM commission_transactions WHERE commission_id = ${cId}
  `;
  if (!orig) throw new Error("Commission transaction not found");
  if (orig.commission_status === 'Reversed') throw new Error("Commission transaction already reversed");

  const reversalAmount = -Number(orig.net_amount || 0);

  const [reversal] = await client`
    INSERT INTO commission_transactions (
      associate_user_id, related_booking_id, commission_type, gaj_sold,
      gross_amount, deduction_amount, net_amount, commission_month, commission_status,
      commission_event_id, commission_model, commission_level, commission_percentage,
      calculation_base, source_type, source_reference, engine_version,
      distribution_role, distribution_participants, seller_user_id, event_key, notes
    ) VALUES (
      ${orig.associate_user_id}, ${orig.related_booking_id}, 'Reversal', ${-Number(orig.gaj_sold || 0)},
      ${reversalAmount}, 0, ${reversalAmount}, ${new Date().toISOString().slice(0, 7)}, 'Reversed',
      ${orig.commission_event_id}, ${orig.commission_model}, ${orig.commission_level}, ${orig.commission_percentage},
      ${orig.calculation_base}, ${orig.source_type}, ${orig.source_reference}, ${orig.engine_version},
      ${orig.distribution_role}, ${orig.distribution_participants}, ${orig.seller_user_id},
      ${orig.event_key ? `rev:${orig.event_key}` : null}, ${'Manual reversal: ' + reason}
    )
    RETURNING *
  `;

  await client`
    UPDATE commission_transactions
    SET commission_status = 'Reversed',
        needs_review = FALSE,
        notes = COALESCE(notes || '; ', '') || 'Reversed by admin ' || ${adminId || 0} || ': ' || ${reason},
        updated_at = NOW()
    WHERE commission_id = ${cId}
  `;

  await client`
    UPDATE associate_sales_tracker
    SET total_commission_earned = total_commission_earned - ${Number(orig.net_amount || 0)},
        updated_at = NOW()
    WHERE associate_user_id = ${orig.associate_user_id}
  `;

  return reversal;
}

export default {
  calculateCommissionDistribution,
  buildCanonicalEventKey,
  ensureCommissionSchemaExtensions,
  getCommissionEngineSnapshot,
  generateCommissionForPayment,
  cancelBookingCommissions,
  reverseCommissionTransaction,
};
