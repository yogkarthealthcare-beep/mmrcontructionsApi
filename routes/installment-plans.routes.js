/**
 * MMR Construction & Developers Pvt. Ltd.
 * Installment Plans & Payment Plan Settings Routes (M2)
 *
 * Endpoints:
 * 1. GET  /api/installment-plans                - List active installment plans for customers/associates
 * 2. POST /api/installment-plans/preview        - Server-side preview calculation (price, plan_id => DP, monthly, interest)
 * 3. GET  /api/admin/installment-plans          - List all installment plans (active & inactive)
 * 4. POST /api/admin/installment-plans          - Create new plan (SuperAdmin only, mandatory reason)
 * 5. PUT  /api/admin/installment-plans/:id      - Update plan (SuperAdmin only, mandatory reason)
 * 6. GET  /api/admin/payment-plan-settings      - Get payment plan settings (part-wise deadline months)
 * 7. PUT  /api/admin/payment-plan-settings      - Update payment plan settings (SuperAdmin only, mandatory reason)
 */

import express from 'express';
import sql from '../db.js';
import { verifyAdminToken, role } from '../middleware/auth.middleware.js';
import installmentService from '../services/installmentService.js';

const router = express.Router();

function ok(res, data = null, message = 'Success', extra = {}) {
  return res.json({ success: true, message, data, ...extra });
}

function err(res, message = 'Error', code = 400) {
  return res.status(code).json({ success: false, message });
}

/**
 * 1. GET /api/installment-plans
 * Public / Authenticated: Returns all active installment plans sorted by sort_order
 */
router.get('/installment-plans', async (req, res) => {
  try {
    const plans = await installmentService.getInstallmentPlans(sql, { activeOnly: true });
    return ok(res, plans, 'Active installment plans retrieved successfully.');
  } catch (e) {
    return err(res, e.message, 500);
  }
});

/**
 * 2. POST /api/installment-plans/preview
 * Calculates exact integer-paise breakdown for a given plot or custom price and plan
 * Body: { plot_id?: number, plan_id: number, custom_price?: number }
 */
router.post('/installment-plans/preview', async (req, res) => {
  try {
    const { plot_id, plan_id, custom_price } = req.body || {};
    if (!plan_id) {
      return err(res, 'plan_id is required for calculation preview.', 400);
    }

    const preview = await installmentService.previewInstallmentPlan(sql, {
      plotId: plot_id,
      planId: plan_id,
      customPrice: custom_price,
    });

    return ok(res, preview, 'Installment calculation preview generated successfully.');
  } catch (e) {
    return err(res, e.message, 400);
  }
});

/**
 * 3. GET /api/admin/installment-plans
 * Admin view: Returns all installment plans (active and inactive)
 */
router.get('/admin/installment-plans', verifyAdminToken, async (req, res) => {
  try {
    const plans = await installmentService.getInstallmentPlans(sql, { activeOnly: false });
    return ok(res, plans, 'All installment plans retrieved successfully.');
  } catch (e) {
    return err(res, e.message, 500);
  }
});

/**
 * 4. POST /api/admin/installment-plans
 * SuperAdmin only: Create new installment plan
 * Body: { tenure_months, interest_percent, down_payment_percent, sort_order?, reason }
 */
router.post('/admin/installment-plans', verifyAdminToken, role('SuperAdmin'), async (req, res) => {
  try {
    const {
      tenure_months,
      interest_percent,
      down_payment_percent,
      sort_order,
      reason
    } = req.body || {};

    if (!reason || !String(reason).trim()) {
      return err(res, 'Reason is mandatory for creating an installment plan.', 400);
    }

    const created = await installmentService.createInstallmentPlan(sql, {
      tenureMonths: tenure_months,
      interestPercent: interest_percent,
      downPaymentPercent: down_payment_percent,
      sortOrder: sort_order,
      adminId: req.admin.admin_id,
      reason: String(reason).trim(),
    });

    // Audit Log
    try {
      await sql`
        INSERT INTO audit_log (
          actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value
        ) VALUES (
          'Admin', ${req.admin.admin_id}, ${req.admin.full_name || 'SuperAdmin'}, 'InstallmentPlans',
          'CreatePlan', 'installment_plans', ${created.id}, ${JSON.stringify({ created, reason })}
        )
      `;
    } catch (_) {}

    return ok(res, created, 'Installment plan created successfully.');
  } catch (e) {
    return err(res, e.message, 400);
  }
});

/**
 * 5. PUT /api/admin/installment-plans/:id
 * SuperAdmin only: Update an existing plan
 * Body: { interest_percent, down_payment_percent, is_active, sort_order, reason }
 */
router.put('/admin/installment-plans/:id', verifyAdminToken, role('SuperAdmin'), async (req, res) => {
  try {
    const planId = Number(req.params.id);
    const {
      interest_percent,
      down_payment_percent,
      is_active,
      sort_order,
      reason
    } = req.body || {};

    if (!reason || !String(reason).trim()) {
      return err(res, 'Reason is mandatory for updating an installment plan.', 400);
    }

    const updated = await installmentService.updateInstallmentPlan(sql, planId, {
      interestPercent: interest_percent,
      downPaymentPercent: down_payment_percent,
      isActive: is_active,
      sortOrder: sort_order,
      adminId: req.admin.admin_id,
      reason: String(reason).trim(),
    });

    // Audit Log
    try {
      await sql`
        INSERT INTO audit_log (
          actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value
        ) VALUES (
          'Admin', ${req.admin.admin_id}, ${req.admin.full_name || 'SuperAdmin'}, 'InstallmentPlans',
          'UpdatePlan', 'installment_plans', ${planId}, ${JSON.stringify({ updated, reason })}
        )
      `;
    } catch (_) {}

    return ok(res, updated, 'Installment plan updated successfully.');
  } catch (e) {
    return err(res, e.message, 400);
  }
});

/**
 * 6. GET /api/admin/payment-plan-settings
 * Admin: Get part-wise deadline setting
 */
router.get('/admin/payment-plan-settings', verifyAdminToken, async (req, res) => {
  try {
    const settings = await installmentService.getPaymentPlanSettings(sql);
    return ok(res, settings, 'Payment plan settings retrieved successfully.');
  } catch (e) {
    return err(res, e.message, 500);
  }
});

/**
 * 7. PUT /api/admin/payment-plan-settings
 * SuperAdmin only: Update part-wise deadline months
 * Body: { part_wise_deadline_months, reason }
 */
router.put('/admin/payment-plan-settings', verifyAdminToken, role('SuperAdmin'), async (req, res) => {
  try {
    const { part_wise_deadline_months, reason } = req.body || {};

    if (!reason || !String(reason).trim()) {
      return err(res, 'Reason is mandatory for updating payment plan settings.', 400);
    }

    const updated = await installmentService.updatePaymentPlanSettings(sql, {
      partWiseDeadlineMonths: part_wise_deadline_months,
      adminId: req.admin.admin_id,
      reason: String(reason).trim(),
    });

    // Audit Log
    try {
      await sql`
        INSERT INTO audit_log (
          actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value
        ) VALUES (
          'Admin', ${req.admin.admin_id}, ${req.admin.full_name || 'SuperAdmin'}, 'PaymentPlanSettings',
          'UpdateDeadline', 'booking_workflow_settings', 1, ${JSON.stringify({ updated, reason })}
        )
      `;
    } catch (_) {}

    return ok(res, updated, 'Payment plan settings updated successfully.');
  } catch (e) {
    return err(res, e.message, 400);
  }
});

export default router;
