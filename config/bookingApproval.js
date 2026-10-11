/**
 * MMR Construction & Developers Pvt. Ltd.
 * Configuration: Booking Approval & Referral Attribution Settings
 */

export const bookingApprovalConfig = {
  // If true, Team Member bookings require Associate approval (status = 'Pending').
  // If false, all bookings are automatically marked 'NotRequired'.
  BOOKING_APPROVAL_ENABLED: process.env.BOOKING_APPROVAL_ENABLED !== 'false',

  // Behavior when user provides non-empty invalid/ineligible referral code on registration:
  // 'reject' -> return 400 "Invalid referral code"
  // 'silent_company_direct' (aliases: 'fallback_direct', 'direct') -> register as Company Direct (referred_by = null)
  REFERRAL_INVALID_CODE_MODE: (process.env.REFERRAL_INVALID_CODE_MODE || 'reject').toLowerCase().trim(),

  // Allow EMI payment plan for on-behalf bookings (default false)
  ALLOW_EMI_ON_BEHALF: process.env.ALLOW_EMI_ON_BEHALF === 'true',

  // Number of hours after which a 'Pending' associate approval is flagged as overdue in admin views
  OVERDUE_HOURS: Number(process.env.BOOKING_APPROVAL_OVERDUE_HOURS) || 48,

  // Default auto-approve for bookings initiated by Associates themselves
  AUTO_APPROVE_ASSOCIATE_BOOKINGS: true
};

export default bookingApprovalConfig;
