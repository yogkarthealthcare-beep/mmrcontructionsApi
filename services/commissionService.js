/**
 * MMR Construction & Developers Pvt. Ltd.
 * Canonical Commission Service (Per-Gaz Fixed Structure)
 *
 * Single Source of Truth for:
 * 1. Team Member / Associate seller attribution strictly via bookings.sold_by_user_id (with referrer fallback)
 * 2. Per-Gaz Fixed Commission Structure (integer-paise exact math):
 *    - Based strictly on Plot Size in Gaz (Square Yards) stored on the booking/plot record
 *    - Seller Team Member: Plot Size (Gaz) * ₹500 -> 'DIRECT_SALE' (Level 1)
 *    - Upline Distribution (1 Associate + up to 9 Team Members = max 10 participants):
 *      Each participant gets Plot Size (Gaz) * ₹50 -> 'UPLINE_DISTRIBUTION' (Level 2/3)
 * 3. Strict Self-Purchase & Company Direct validation (0% commission)
 * 4. Canonical event_key & booking-level idempotency preventing duplicate payouts across all routes
 * 5. Safe non-destructive cancellation (Pending -> Cancelled, Approved/Paid -> needs_review) & reversals
 */

import sql from '../db.js';

export const SELLER_RATE_PER_GAZ = 500;
export const UPLINE_RATE_PER_GAZ = 50;
export const MAX_UPLINE_PARTICIPANTS = 10; // 1 Associate + 9 Team Members
export const MAX_TEAM_MEMBER_UPLINE_SLOTS = 9;

/**
 * Pure math helper calculating Per-Gaz fixed commission distribution in integer paise.
 * Invariant: totalDistributedAmount + undistributedAmount === poolAmount (max 10-upline + seller pool).
 */
export function calculateCommissionDistribution({
  plotSizeGaj,
  baseAmount = 0,
  sellerRatePerGaj = SELLER_RATE_PER_GAZ,
  uplineRatePerGaj = UPLINE_RATE_PER_GAZ,
  participantsCount = 0,
  isTeamMemberSeller = true,
  maxUplineParticipants = MAX_UPLINE_PARTICIPANTS,
}) {
  const gaz = Math.max(Number(plotSizeGaj ?? 0), 0);
  const sellerRate = Math.max(Number(sellerRatePerGaj ?? SELLER_RATE_PER_GAZ), 0);
  const uplineRate = Math.max(Number(uplineRatePerGaj ?? UPLINE_RATE_PER_GAZ), 0);
  const maxUpline = Math.max(parseInt(maxUplineParticipants ?? MAX_UPLINE_PARTICIPANTS, 10) || MAX_UPLINE_PARTICIPANTS, 0);
  const effectiveParticipants = Math.min(Math.max(parseInt(participantsCount || 0, 10) || 0, 0), maxUpline);

  if (!(gaz > 0)) {
    return {
      plotSizeGaj: 0,
      baseAmount: Number(baseAmount || 0),
      sellerRatePerGaj: sellerRate,
      uplineRatePerGaj: uplineRate,
      maxUplineParticipants: maxUpline,
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
      participantsCount: effectiveParticipants,
      isTeamMemberSeller: Boolean(isTeamMemberSeller),
    };
  }

  // Convert to integer paise to eliminate floating point imprecision
  const sellerInPaise = Math.round(gaz * sellerRate * 100);
  const eachInPaise = effectiveParticipants > 0 ? Math.round(gaz * uplineRate * 100) : 0;
  const totalUplineInPaise = eachInPaise * effectiveParticipants;
  const theoreticalMaxUplineInPaise = Math.round(gaz * uplineRate * 100) * maxUpline;
  const theoreticalMaxPoolInPaise = sellerInPaise + theoreticalMaxUplineInPaise;
  const totalDistributedInPaise = sellerInPaise + totalUplineInPaise;
  const undistributedInPaise = Math.max(0, theoreticalMaxPoolInPaise - totalDistributedInPaise);

  if (totalDistributedInPaise + undistributedInPaise !== theoreticalMaxPoolInPaise) {
    throw new Error(
      `Commission math discrepancy: distributed (${totalDistributedInPaise}) + undistributed (${undistributedInPaise}) !== max pool (${theoreticalMaxPoolInPaise})`
    );
  }

  return {
    plotSizeGaj: Number(gaz.toFixed(2)),
    baseAmount: Number(baseAmount || 0),
    sellerRatePerGaj: sellerRate,
    uplineRatePerGaj: uplineRate,
    maxUplineParticipants: maxUpline,
    poolAmount: Number((theoreticalMaxPoolInPaise / 100).toFixed(2)),
    sellerAmount: Number((sellerInPaise / 100).toFixed(2)),
    baseSellerAmount: Number((sellerInPaise / 100).toFixed(2)),
    sellerRemainderAmount: 0,
    remainingPoolAmount: Number((totalUplineInPaise / 100).toFixed(2)),
    eachShareAmount: Number((eachInPaise / 100).toFixed(2)),
    associateShareAmount:
      isTeamMemberSeller && effectiveParticipants > 0
        ? Number((eachInPaise / 100).toFixed(2))
        : 0,
    associateRemainderAmount: 0,
    undistributedAmount: Number((undistributedInPaise / 100).toFixed(2)),
    totalDistributedAmount: Number((totalDistributedInPaise / 100).toFixed(2)),
    participantsCount: effectiveParticipants,
    isTeamMemberSeller: Boolean(isTeamMemberSeller),
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
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS plot_area NUMERIC(12,2) DEFAULT 0
  `.catch(() => {});

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
    ADD COLUMN IF NOT EXISTS review_reason TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS approved_by_admin_id INT,
    ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_reference TEXT,
    ADD COLUMN IF NOT EXISTS notes TEXT
  `.catch(() => {});

  // Convert legacy enum-backed columns to VARCHAR(50) so all commission types/statuses (e.g. 'Reversed', 'Rejected', 'Processed', 'DIRECT_SALE', 'UPLINE_DISTRIBUTION') work without enum errors
  await db`
    DO $$
    DECLARE
      rec RECORD;
    BEGIN
      FOR rec IN
        SELECT * FROM (VALUES
          ('commission_type', NULL::text),
          ('commission_status', 'Pending'::text)
        ) AS t(col_name, def_val)
      LOOP
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'commission_transactions'
            AND column_name = rec.col_name
            AND data_type = 'USER-DEFINED'
        ) THEN
          EXECUTE format('ALTER TABLE commission_transactions ALTER COLUMN %I DROP DEFAULT', rec.col_name);
          EXECUTE format('ALTER TABLE commission_transactions ALTER COLUMN %I TYPE VARCHAR(50) USING %I::text', rec.col_name, rec.col_name);
          IF rec.def_val IS NOT NULL THEN
            EXECUTE format('ALTER TABLE commission_transactions ALTER COLUMN %I SET DEFAULT %L', rec.col_name, rec.def_val);
          END IF;
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[Commission] Enum-to-VARCHAR migration notice: %', SQLERRM;
    END $$;
  `.catch((e) => {
    console.warn('[Commission] Schema column migration notice:', e.message);
  });

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
      commission_model: 'PerGazFixed',
      version: 1,
      seller_rate_per_gaz: SELLER_RATE_PER_GAZ,
      upline_rate_per_gaz: UPLINE_RATE_PER_GAZ,
      max_upline_participants: MAX_UPLINE_PARTICIPANTS,
      eligibility_rules: {},
    };
  }
  return {
    ...settingsRow,
    seller_rate_per_gaz: Number(settingsRow.seller_rate_per_gaz ?? SELLER_RATE_PER_GAZ),
    upline_rate_per_gaz: Number(settingsRow.upline_rate_per_gaz ?? UPLINE_RATE_PER_GAZ),
    max_upline_participants: Number(settingsRow.max_upline_participants ?? MAX_UPLINE_PARTICIPANTS),
  };
}

/**
 * Centralized Per-Gaz Commission Generation Function
 *
 * Parameters:
 * - bookingId: integer ID of the booking
 * - event: { type, key, principalAmount, receivedAmount, sourceRef, paymentType }
 * - adminId: integer ID of approving admin (optional)
 * - db: postgres client/transaction (optional, defaults to sql)
 */
export async function generateCommissionForPayment({
  bookingId,
  event = {},
  adminId = null,
  db = null,
  sourceType: topSourceType = null,
  sourceId: topSourceId = null,
  receivedAmount: topReceivedAmount = null,
  principalAmount: topPrincipalAmount = null,
  paymentType: topPaymentType = null,
  eventKey: topEventKey = null,
}) {
  const bId = Number(bookingId);
  if (!bId || bId <= 0) return { generated: 0, reason: "Invalid booking ID" };

  const validSourceTypes = ['FullPayment','InitialPayment','EmiPayment','PartialPayment','Manual','BookingAdvance','MilestonePayment','OnlinePayment','OfflinePayment','PaymentSettlement'];
  const rawSourceType = event.type || event.sourceType || topSourceType || "InitialPayment";
  const sourceType = validSourceTypes.includes(rawSourceType) ? rawSourceType : "BookingAdvance";
  const sourceId = String(event.sourceRef || event.sourceId || topSourceId || bId);
  const paymentType = event.paymentType || topPaymentType || "Standard";
  const principalAmount = Number(
    event.principalAmount ?? event.receivedAmount ?? topPrincipalAmount ?? topReceivedAmount ?? 0
  );

  const eventKey = buildCanonicalEventKey({
    bookingId: bId,
    sourceType,
    sourceId,
    eventKey: event.key || event.eventKey || topEventKey,
  });

  const runWithDb = async (tx) => {
    // 1. Transaction Advisory Lock on booking
    await tx`SELECT pg_advisory_xact_lock(${bId})`;
    await ensureCommissionSchemaExtensions(tx);

    // 2. Fetch booking and plot data (Plot Size in Gaz is the canonical calculation base)
    const [booking] = await tx`
      SELECT b.booking_id, b.booking_serial, b.booking_status, b.booking_type,
             b.user_id, b.booked_by_user_id, b.sold_by_user_id, b.associate_user_id,
             b.payment_type, b.advance_amount,
             COALESCE(NULLIF(b.plot_area, 0), p.plot_area, 0)::numeric AS plot_area,
             p.plot_id, p.area_unit, p.base_price, p.plot_number,
             s.site_name
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      WHERE b.booking_id = ${bId}
    `;

    if (!booking) return { generated: 0, reason: "Booking not found" };

    // 3. Strict Self-Purchase & Company Direct Validation (0% commission)
    const [buyerUser] = await tx`
      SELECT user_id, user_type, referred_by_user_id, sponsor_user_id
      FROM users WHERE user_id = ${booking.user_id} LIMIT 1
    `;
    const [buyerTmRow] = await tx`
      SELECT id FROM team_members
      WHERE user_id = ${booking.user_id}
        AND LOWER(status) IN ('approved', 'active')
      LIMIT 1
    `;

    const distinctBookedById =
      booking.booked_by_user_id && Number(booking.booked_by_user_id) !== Number(booking.user_id)
        ? Number(booking.booked_by_user_id)
        : 0;

    const resolvedSellerId = Number(
      booking.sold_by_user_id ||
      distinctBookedById ||
      buyerUser?.referred_by_user_id ||
      buyerUser?.sponsor_user_id ||
      0
    );

    if (!resolvedSellerId) {
      // Company Direct sale - 0% commission
      return { generated: 0, reason: "No seller attributed (Company Direct)" };
    }
    booking.sold_by_user_id = resolvedSellerId;

    const isNonCustomerBuyer =
      Boolean(buyerTmRow) ||
      ['Associate', 'Team Member', 'Admin', 'SuperAdmin'].includes(buyerUser?.user_type);

    const isSelfPurchase = Boolean(
      booking.booking_type === 'SELF_PURCHASE' ||
      isNonCustomerBuyer ||
      Number(booking.user_id) === resolvedSellerId ||
      (booking.associate_user_id && Number(booking.user_id) === Number(booking.associate_user_id))
    );

    if (isSelfPurchase) {
      return { generated: 0, reason: "Self-purchase by Associate or Team Member (commission disabled)" };
    }

    if (['Cancelled', 'Rejected', 'Pending Admin Price Approval'].includes(booking.booking_status)) {
      return { generated: 0, reason: "Booking is cancelled, rejected, or pending admin price approval" };
    }

    const plotSizeGaj = Number(booking.plot_area || 0);
    if (!(plotSizeGaj > 0)) {
      return { generated: 0, reason: "Plot size in Gaz must be greater than zero" };
    }

    // 4. Idempotency Check: check event_key/source_id AND ensure Per-Gaz plot commission is generated at most once per booking
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

    const [existingPerGazTx] = await tx`
      SELECT commission_id
      FROM commission_transactions
      WHERE related_booking_id = ${bId}
        AND commission_status::text NOT IN ('Cancelled', 'Reversed')
        AND (
          commission_type IN ('DIRECT_SALE', 'UPLINE_DISTRIBUTION')
          OR commission_model = 'PerGazFixed'
        )
      LIMIT 1
    `;
    if (existingPerGazTx) {
      return {
        generated: 0,
        reason: "Per-Gaz commission already generated for this booking",
        already_generated: true,
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

    // 6. Resolve Seller (sold_by_user_id or resolved referrer)
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

    // 7. Resolve Seller Role & Parent Associate Hierarchy
    const [tmSellerRow] = await tx`
      SELECT associate_id
      FROM team_members
      WHERE user_id = ${sellerUserId}
        AND LOWER(status) IN ('approved', 'active')
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const isTeamMemberSeller = Boolean(tmSellerRow) || seller.user_type === 'Team Member';
    let leaderUserId = isTeamMemberSeller
      ? Number(tmSellerRow?.associate_id || booking.associate_user_id || seller.sponsor_user_id || 0)
      : sellerUserId;

    if (isTeamMemberSeller && (!leaderUserId || leaderUserId === sellerUserId)) {
      const [sellerUserRow] = await tx`
        SELECT sponsor_user_id, referred_by_user_id FROM users WHERE user_id = ${sellerUserId} LIMIT 1
      `;
      const fallbackLeader = Number(sellerUserRow?.sponsor_user_id || sellerUserRow?.referred_by_user_id || 0);
      if (fallbackLeader > 0) {
        leaderUserId = fallbackLeader;
      }
    }

    // 8. Fetch Active/Eligible Team Members under Parent Associate (deterministic slot order)
    const teamRows = leaderUserId
      ? await tx`
          SELECT DISTINCT tm.user_id, tm.slot_number, tm.id,
                 COALESCE(u.account_status, 'Active') AS account_status,
                 'Team Member' AS user_type
          FROM team_members tm
          LEFT JOIN users u ON tm.user_id = u.user_id
          WHERE tm.associate_id = ${leaderUserId}
            AND LOWER(tm.status) IN ('approved', 'active')
            AND tm.user_id IS NOT NULL
          ORDER BY tm.slot_number ASC NULLS LAST, tm.id ASC
        `
      : [];

    const eligibleTeamMembers = teamRows.filter((m) => {
      if (Number(m.user_id) === sellerUserId) return false;
      const isMemberActive = ['Active', 'Approved'].includes(m.account_status);
      if (eligibility.require_active_associate !== false && !isMemberActive) return false;
      if (eligibility.exclude_blacklisted !== false && m.account_status === 'Blacklisted') return false;
      return true;
    });

    // 9. Prepare Upline Participants: 1 Associate Leader + up to 9 Active Team Members (Total max 10)
    const remainingParticipants = [];
    if (isTeamMemberSeller) {
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

      for (const tm of eligibleTeamMembers.slice(0, MAX_TEAM_MEMBER_UPLINE_SLOTS)) {
        remainingParticipants.push({
          user_id: Number(tm.user_id),
          user_type: 'Team Member',
          role: 'TeamMember',
        });
      }
    } else {
      for (const tm of eligibleTeamMembers.slice(0, MAX_UPLINE_PARTICIPANTS)) {
        remainingParticipants.push({
          user_id: Number(tm.user_id),
          user_type: 'Team Member',
          role: 'TeamMember',
        });
      }
    }

    const uplineParticipants = remainingParticipants.slice(0, MAX_UPLINE_PARTICIPANTS);
    const participantCount = uplineParticipants.length;

    // 10. Perform Per-Gaz Fixed Math in Integer Paise
    const sellerRatePerGaj = SELLER_RATE_PER_GAZ;
    const uplineRatePerGaj = UPLINE_RATE_PER_GAZ;
    const math = calculateCommissionDistribution({
      plotSizeGaj,
      baseAmount: principalAmount || Number(booking.base_price || 0),
      sellerRatePerGaj,
      uplineRatePerGaj,
      participantsCount: participantCount,
      isTeamMemberSeller,
      maxUplineParticipants: MAX_UPLINE_PARTICIPANTS,
    });

    // 11. Insert Commission Source Event
    const currentMonth = new Date().toISOString().slice(0, 7);
    const effectiveAdminId = adminId || null;
    const recordedEventAmount = Math.max(
      Number(principalAmount || 0),
      Number(booking.advance_amount || 0),
      Number(booking.base_price || 0),
      plotSizeGaj,
      1
    );
    const perGazSettingsSnapshot = {
      ...engine,
      commission_model: 'PerGazFixed',
      plot_size_gaj: plotSizeGaj,
      seller_rate_per_gaz: sellerRatePerGaj,
      upline_rate_per_gaz: uplineRatePerGaj,
      max_upline_participants: MAX_UPLINE_PARTICIPANTS,
    };

    let [eventRow] = await tx`
      INSERT INTO commission_source_events (
        booking_id, source_type, source_id, payment_type, received_amount,
        plot_amount, plot_area_gaj, commission_model, engine_version, generated_by_admin_id,
        event_key, undistributed_amount, settings_snapshot
      ) VALUES (
        ${bId}, ${sourceType}, ${sourceId}, ${paymentType}, ${recordedEventAmount},
        ${Number(booking.base_price || 0)}, ${plotSizeGaj},
        'PerGazFixed', ${engine.version || 1}, ${effectiveAdminId},
        ${eventKey}, ${math.undistributedAmount}, ${tx.json(perGazSettingsSnapshot)}
      )
      RETURNING event_id
    `;

    if (!eventRow) {
      return { generated: 0, reason: "Payment event already processed", event_key: eventKey };
    }

    const eventId = eventRow.event_id;
    let generated = 0;
    let totalCommissionDistributed = 0;

    // Defensive helper to update sales tracker without failing on missing unique constraint
    const updateSalesTracker = async (userId, gajSold, commissionAmount) => {
      try {
        const [updated] = await tx`
          UPDATE associate_sales_tracker
          SET total_gaj_sold = COALESCE(total_gaj_sold, 0) + ${Number(gajSold || 0)},
              total_commission_earned = COALESCE(total_commission_earned, 0) + ${Number(commissionAmount || 0)},
              updated_at = NOW()
          WHERE associate_user_id = ${userId}
          RETURNING tracker_id
        `;
        if (!updated) {
          await tx`
            INSERT INTO associate_sales_tracker (associate_user_id, total_gaj_sold, total_commission_earned)
            VALUES (${userId}, ${Number(gajSold || 0)}, ${Number(commissionAmount || 0)})
          `.catch(async () => {
            await tx`
              UPDATE associate_sales_tracker
              SET total_gaj_sold = COALESCE(total_gaj_sold, 0) + ${Number(gajSold || 0)},
                  total_commission_earned = COALESCE(total_commission_earned, 0) + ${Number(commissionAmount || 0)},
                  updated_at = NOW()
              WHERE associate_user_id = ${userId}
            `.catch(() => {});
          });
        }
      } catch (err) {
        console.warn(`[associate_sales_tracker] update warning for user ${userId}:`, err?.message);
      }
    };

    const plotLabel = booking.plot_number ? `Plot ${booking.plot_number}` : `Plot #${booking.plot_id || bId}`;
    const bookingLabel = booking.booking_serial || `#${bId}`;

    // 12. Direct Seller Payout Insertion ('DIRECT_SALE', Level 1, ₹500/Gaz)
    if (math.sellerAmount > 0) {
      const sellerNote = `DIRECT_SALE (Level 1): ${plotSizeGaj} Gaz × ₹${sellerRatePerGaj}/Gaz = ₹${math.sellerAmount.toFixed(2)} (${plotLabel}, Booking ${bookingLabel})`;

      const [comm] = await tx`
        INSERT INTO commission_transactions (
          associate_user_id, related_booking_id, commission_type, gaj_sold,
          gross_amount, deduction_amount, net_amount, commission_month, commission_status,
          commission_event_id, commission_model, commission_level, commission_percentage,
          calculation_base, source_type, source_reference, engine_version,
          distribution_role, distribution_participants, seller_user_id, event_key, notes
        ) VALUES (
          ${sellerUserId}, ${bId}, 'DIRECT_SALE', ${plotSizeGaj},
          ${math.sellerAmount}, 0, ${math.sellerAmount}, ${currentMonth}, 'Pending',
          ${eventId}, 'PerGazFixed', 1, 0,
          ${plotSizeGaj}, ${sourceType}, ${sourceId}, ${engine.version || 1},
          'Seller', ${participantCount}, ${sellerUserId}, ${eventKey}, ${sellerNote}
        )
        ON CONFLICT DO NOTHING
        RETURNING commission_id
      `;

      if (comm) {
        await updateSalesTracker(sellerUserId, plotSizeGaj, math.sellerAmount);
        generated++;
        totalCommissionDistributed += math.sellerAmount;
      }
    }

    // 13. Associate & Team Members Payout Insertion ('UPLINE_DISTRIBUTION', Level 2/3, ₹50/Gaz)
    if (participantCount > 0 && math.eachShareAmount > 0) {
      for (const p of uplineParticipants) {
        const payout = math.eachShareAmount;
        if (!(payout > 0)) continue;

        const level = p.role === 'AssociateLeader' ? 2 : 3;
        const roleLabel = p.role === 'AssociateLeader' ? 'Associate Leader' : 'Team Member';
        const uplineNote = `UPLINE_DISTRIBUTION (Level ${level} - ${roleLabel}): ${plotSizeGaj} Gaz × ₹${uplineRatePerGaj}/Gaz = ₹${payout.toFixed(2)} (${participantCount}/${MAX_UPLINE_PARTICIPANTS} upline members, ${plotLabel}, Booking ${bookingLabel})`;

        const [comm] = await tx`
          INSERT INTO commission_transactions (
            associate_user_id, related_booking_id, commission_type, gaj_sold,
            gross_amount, deduction_amount, net_amount, commission_month, commission_status,
            commission_event_id, commission_model, commission_level, commission_percentage,
            calculation_base, source_type, source_reference, engine_version,
            distribution_role, distribution_participants, seller_user_id, event_key, notes
          ) VALUES (
            ${p.user_id}, ${bId}, 'UPLINE_DISTRIBUTION', 0,
            ${payout}, 0, ${payout}, ${currentMonth}, 'Pending',
            ${eventId}, 'PerGazFixed', ${level}, 0,
            ${plotSizeGaj}, ${sourceType}, ${sourceId}, ${engine.version || 1},
            ${p.role}, ${participantCount}, ${sellerUserId}, ${eventKey}, ${uplineNote}
          )
          ON CONFLICT DO NOTHING
          RETURNING commission_id
        `;

        if (comm) {
          await updateSalesTracker(p.user_id, 0, payout);
          generated++;
          totalCommissionDistributed += payout;
        }
      }
    }

    return {
      generated,
      total_commission: Number(totalCommissionDistributed.toFixed(2)),
      model: 'PerGazFixed',
      version: engine.version || 1,
      plot_size_gaj: plotSizeGaj,
      seller_rate_per_gaz: sellerRatePerGaj,
      upline_rate_per_gaz: uplineRatePerGaj,
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

  await ensureCommissionSchemaExtensions(client);

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
  SELLER_RATE_PER_GAZ,
  UPLINE_RATE_PER_GAZ,
  MAX_UPLINE_PARTICIPANTS,
  MAX_TEAM_MEMBER_UPLINE_SLOTS,
  calculateCommissionDistribution,
  buildCanonicalEventKey,
  ensureCommissionSchemaExtensions,
  getCommissionEngineSnapshot,
  generateCommissionForPayment,
  cancelBookingCommissions,
  reverseCommissionTransaction,
};
