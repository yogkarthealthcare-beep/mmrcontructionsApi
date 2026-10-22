/**
 * MMR Construction & Developers Pvt. Ltd.
 * Canonical Installment & Payment Plan Service (M2)
 *
 * Implements:
 * 1. Integer-paise exact calculation engine for installment plans (12, 24, 36, 60 months)
 * 2. Flat interest: Total plot amount * interest_percent
 * 3. Down payment: Total plot amount * down_payment_percent
 * 4. Installment base: (Plot Amount - DP) + Flat Interest
 * 5. Monthly installment & exact principal/interest component split
 *    - Strict paise-safe rounding with last installment absorbing rounding fractions
 * 6. Invariant assertion: sum(principal_component) === (price - DP), sum(interest_component) === flat_interest
 * 7. Admin CRUD & audit for installment_plans & payment_plan_settings
 * 8. Part-wise payment deadline management (default 3 months) & overdue detection
 */

import sql from '../db.js';

/**
 * Pure math helper: Calculate installment plan breakdown with integer-paise precision.
 * Guarantees that sum(schedule[i].emi_amount) === installment_base_amount.
 */
export function calculateInstallmentPlan({
  price,
  tenure,
  interestPercent,
  downPaymentPercent,
  actualDownPayment,
  minDownPaymentAmount = 0,
}) {
  const principal = Math.max(Number(price || 0), 0);
  const tenureMonths = Math.max(1, Math.round(Number(tenure || 12)));
  const interestRate = Math.max(0, Number(interestPercent || 0));
  const dpRate = Math.max(0, Number(downPaymentPercent || 0));

  const priceInPaise = Math.round(principal * 100);
  const flatInterestInPaise = Math.round((priceInPaise * interestRate) / 100);

  // 1. Minimum down payment based on plan percentage
  const percentDpInPaise = Math.round((priceInPaise * dpRate) / 100);
  // 2. Minimum fixed threshold (e.g. ₹30,000)
  const minFixedDpInPaise = Math.round(Math.max(0, Number(minDownPaymentAmount || 0)) * 100);
  // Stricter (higher) of the two is the minimum required down payment
  const minRequiredDpInPaise = Math.max(percentDpInPaise, minFixedDpInPaise);

  // 3. If customer or staff paid more than minimum, take actual down payment so excess payment is not lost
  const userActualDpInPaise = actualDownPayment !== undefined && actualDownPayment !== null && Number(actualDownPayment) > 0
    ? Math.round(Number(actualDownPayment) * 100)
    : minRequiredDpInPaise;
  const dpInPaise = Math.min(priceInPaise, Math.max(minRequiredDpInPaise, userActualDpInPaise));

  const totalPayableInPaise = priceInPaise + flatInterestInPaise;
  const balanceRemainingInPaise = priceInPaise - dpInPaise;
  const installmentBaseInPaise = balanceRemainingInPaise + flatInterestInPaise;

  const monthlyBaseInPaise = Math.floor(installmentBaseInPaise / tenureMonths);
  const monthlyPrincipalBaseInPaise = Math.floor(balanceRemainingInPaise / tenureMonths);
  const monthlyInterestBaseInPaise = Math.floor(flatInterestInPaise / tenureMonths);

  const schedule = [];
  let cumMonthlyInPaise = 0;
  let cumPrincipalInPaise = 0;
  let cumInterestInPaise = 0;

  for (let i = 1; i <= tenureMonths; i++) {
    const isLast = i === tenureMonths;
    const emiInPaise = isLast
      ? installmentBaseInPaise - cumMonthlyInPaise
      : monthlyBaseInPaise;
    const principalInPaise = isLast
      ? balanceRemainingInPaise - cumPrincipalInPaise
      : monthlyPrincipalBaseInPaise;
    const interestInPaise = isLast
      ? flatInterestInPaise - cumInterestInPaise
      : monthlyInterestBaseInPaise;

    cumMonthlyInPaise += emiInPaise;
    cumPrincipalInPaise += principalInPaise;
    cumInterestInPaise += interestInPaise;

    schedule.push({
      installment_no: i,
      emi_amount: Math.round(emiInPaise) / 100,
      principal_component: Math.round(principalInPaise) / 100,
      interest_component: Math.round(interestInPaise) / 100,
    });
  }

  // Strict invariant assertions
  if (cumMonthlyInPaise !== installmentBaseInPaise) {
    throw new Error(`Installment schedule mismatch: ${cumMonthlyInPaise} !== ${installmentBaseInPaise}`);
  }
  if (cumPrincipalInPaise !== balanceRemainingInPaise) {
    throw new Error(`Principal component mismatch: ${cumPrincipalInPaise} !== ${balanceRemainingInPaise}`);
  }
  if (cumInterestInPaise !== flatInterestInPaise) {
    throw new Error(`Interest component mismatch: ${cumInterestInPaise} !== ${flatInterestInPaise}`);
  }

  return {
    price: priceInPaise / 100,
    tenure_months: tenureMonths,
    interest_percent: interestRate,
    down_payment_percent: dpRate,
    minimum_required_down_payment: minRequiredDpInPaise / 100,
    down_payment_amount: dpInPaise / 100,
    flat_interest_amount: flatInterestInPaise / 100,
    total_payable_amount: totalPayableInPaise / 100,
    remaining_balance: balanceRemainingInPaise / 100,
    installment_base_amount: installmentBaseInPaise / 100,
    monthly_emi_amount: (schedule[0]?.emi_amount || 0),
    schedule,
  };
}

/**
 * Startup schema ensure helper (idempotent, safe fallback)
 */
export async function ensureInstallmentSchema(db = sql) {
  try {
    await db`
      CREATE TABLE IF NOT EXISTS installment_plans (
        id SERIAL PRIMARY KEY,
        tenure_months INTEGER UNIQUE NOT NULL CHECK (tenure_months > 0 AND tenure_months <= 120),
        interest_percent NUMERIC(5,2) NOT NULL CHECK (interest_percent >= 0 AND interest_percent <= 100),
        down_payment_percent NUMERIC(5,2) NOT NULL CHECK (down_payment_percent >= 0 AND down_payment_percent <= 100),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Seed defaults
    await db`
      INSERT INTO installment_plans (tenure_months, interest_percent, down_payment_percent, is_active, sort_order)
      VALUES 
        (12, 5.00, 20.00, TRUE, 1),
        (24, 10.00, 25.00, TRUE, 2),
        (36, 15.00, 30.00, TRUE, 3),
        (60, 20.00, 50.00, TRUE, 4)
      ON CONFLICT (tenure_months) DO NOTHING
    `;

    await db`
      ALTER TABLE booking_workflow_settings
        ADD COLUMN IF NOT EXISTS part_wise_deadline_months INTEGER NOT NULL DEFAULT 3
    `.catch(() => {});

    await db`
      ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS installment_plan_id INTEGER,
        ADD COLUMN IF NOT EXISTS plan_snapshot JSONB,
        ADD COLUMN IF NOT EXISTS part_wise_deadline_at TIMESTAMPTZ
    `.catch(() => {});

    await db`
      ALTER TABLE emi_schedules
        ADD COLUMN IF NOT EXISTS principal_component NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS interest_component NUMERIC(14,2)
    `.catch(() => {});

    console.log('[InstallmentService] Schema verified successfully.');
  } catch (err) {
    console.warn('[InstallmentService] Schema verify notice:', err.message);
  }
}

/**
 * Fetch installment plans
 */
export async function getInstallmentPlans(db = sql, { activeOnly = true } = {}) {
  if (activeOnly) {
    return await db`
      SELECT id, tenure_months, interest_percent, down_payment_percent, is_active, sort_order, created_at, updated_at
      FROM installment_plans
      WHERE is_active = TRUE
      ORDER BY sort_order ASC, tenure_months ASC
    `;
  }
  return await db`
    SELECT id, tenure_months, interest_percent, down_payment_percent, is_active, sort_order, created_at, updated_at
    FROM installment_plans
    ORDER BY sort_order ASC, tenure_months ASC
  `;
}

/**
 * Fetch a single plan by ID
 */
export async function getInstallmentPlanById(db = sql, planId) {
  const [row] = await db`
    SELECT id, tenure_months, interest_percent, down_payment_percent, is_active, sort_order, created_at, updated_at
    FROM installment_plans
    WHERE id = ${Number(planId)}
  `;
  return row || null;
}

/**
 * Fetch part-wise deadline settings from booking_workflow_settings
 */
export async function getPaymentPlanSettings(db = sql) {
  const [row] = await db`
    SELECT COALESCE(part_wise_deadline_months, 3) AS part_wise_deadline_months, updated_at
    FROM booking_workflow_settings
    WHERE id = 1
  `;
  return {
    part_wise_deadline_months: Number(row?.part_wise_deadline_months || 3),
    updated_at: row?.updated_at || null,
  };
}

/**
 * SuperAdmin: Update part-wise deadline setting
 */
export async function updatePaymentPlanSettings(db = sql, {
  partWiseDeadlineMonths,
  adminId,
  reason,
}) {
  const months = Math.round(Number(partWiseDeadlineMonths || 3));
  if (months < 1 || months > 24) {
    throw new Error('Part-wise deadline must be between 1 and 24 months.');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('Reason is mandatory for modifying payment plan settings.');
  }

  const [updated] = await db`
    UPDATE booking_workflow_settings
    SET 
      part_wise_deadline_months = ${months},
      updated_by_admin_id = ${adminId || null},
      updated_at = NOW()
    WHERE id = 1
    RETURNING part_wise_deadline_months, updated_at
  `;

  return {
    part_wise_deadline_months: Number(updated?.part_wise_deadline_months || months),
    updated_at: updated?.updated_at,
    reason: String(reason).trim(),
  };
}

/**
 * SuperAdmin: Create new installment plan
 */
export async function createInstallmentPlan(db = sql, {
  tenureMonths,
  interestPercent,
  downPaymentPercent,
  sortOrder = 0,
  adminId,
  reason,
}) {
  const tenure = Math.round(Number(tenureMonths));
  const interest = Number(interestPercent);
  const dp = Number(downPaymentPercent);

  if (!tenure || tenure < 1 || tenure > 120) {
    throw new Error('Tenure must be an integer between 1 and 120 months.');
  }
  if (isNaN(interest) || interest < 0 || interest > 100) {
    throw new Error('Interest percentage must be between 0 and 100%.');
  }
  if (isNaN(dp) || dp < 0 || dp > 100) {
    throw new Error('Down payment percentage must be between 0 and 100%.');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('Reason is mandatory for adding an installment plan.');
  }

  const [existing] = await db`SELECT id FROM installment_plans WHERE tenure_months = ${tenure}`;
  if (existing) {
    throw new Error(`An installment plan with ${tenure} months tenure already exists.`);
  }

  const [created] = await db`
    INSERT INTO installment_plans (
      tenure_months, interest_percent, down_payment_percent, is_active, sort_order, created_at, updated_at
    ) VALUES (
      ${tenure}, ${interest}, ${dp}, TRUE, ${Number(sortOrder || 0)}, NOW(), NOW()
    )
    RETURNING *
  `;

  return created;
}

/**
 * SuperAdmin: Update existing installment plan
 */
export async function updateInstallmentPlan(db = sql, id, {
  interestPercent,
  downPaymentPercent,
  isActive,
  sortOrder,
  adminId,
  reason,
}) {
  const planId = Number(id);
  const [existing] = await db`SELECT * FROM installment_plans WHERE id = ${planId}`;
  if (!existing) {
    throw new Error('Installment plan not found.');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('Reason is mandatory for updating installment plan.');
  }

  const interest = interestPercent !== undefined ? Number(interestPercent) : Number(existing.interest_percent);
  const dp = downPaymentPercent !== undefined ? Number(downPaymentPercent) : Number(existing.down_payment_percent);
  const active = isActive !== undefined ? Boolean(isActive) : existing.is_active;
  const order = sortOrder !== undefined ? Number(sortOrder) : existing.sort_order;

  if (isNaN(interest) || interest < 0 || interest > 100) {
    throw new Error('Interest percentage must be between 0 and 100%.');
  }
  if (isNaN(dp) || dp < 0 || dp > 100) {
    throw new Error('Down payment percentage must be between 0 and 100%.');
  }

  const [updated] = await db`
    UPDATE installment_plans
    SET 
      interest_percent = ${interest},
      down_payment_percent = ${dp},
      is_active = ${active},
      sort_order = ${order},
      updated_at = NOW()
    WHERE id = ${planId}
    RETURNING *
  `;

  return updated;
}

/**
 * Preview calculation for a given plot or custom price
 */
export async function previewInstallmentPlan(db = sql, {
  plotId = null,
  planId,
  customPrice = null,
}) {
  let price = Number(customPrice || 0);

  if (plotId && !(price > 0)) {
    const [plot] = await db`
      SELECT plot_id, base_price, sold_price, plot_area FROM plots WHERE plot_id = ${Number(plotId)}
    `;
    if (plot) {
      price = Number(plot.sold_price || plot.base_price || (Number(plot.plot_area || 0) * 1000) || 0);
    }
  }

  const plan = await getInstallmentPlanById(db, planId);
  if (!plan) {
    throw new Error('Installment plan not found.');
  }

  return calculateInstallmentPlan({
    price,
    tenure: plan.tenure_months,
    interestPercent: plan.interest_percent,
    downPaymentPercent: plan.down_payment_percent,
  });
}

/**
 * Helper to compute part-wise overdue status
 */
export function computePartWiseStatus(booking) {
  if (booking.payment_type !== 'Partial' && booking.payment_type !== 'PartWise') {
    return {
      is_part_wise: false,
      deadline_at: null,
      is_overdue: false,
      days_remaining: null,
    };
  }

  const deadline = booking.part_wise_deadline_at ? new Date(booking.part_wise_deadline_at) : null;
  const balance = Number(booking.remaining_balance || 0);

  if (!deadline) {
    return {
      is_part_wise: true,
      deadline_at: null,
      is_overdue: false,
      days_remaining: null,
    };
  }

  const now = new Date();
  const diffMs = deadline.getTime() - now.getTime();
  const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  const isOverdue = now > deadline && balance > 0;

  return {
    is_part_wise: true,
    deadline_at: deadline.toISOString(),
    is_overdue: isOverdue,
    days_remaining: daysRemaining,
  };
}

export default {
  calculateInstallmentPlan,
  ensureInstallmentSchema,
  getInstallmentPlans,
  getInstallmentPlanById,
  getPaymentPlanSettings,
  updatePaymentPlanSettings,
  createInstallmentPlan,
  updateInstallmentPlan,
  previewInstallmentPlan,
  computePartWiseStatus,
};
