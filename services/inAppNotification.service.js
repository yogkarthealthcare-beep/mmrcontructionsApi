import sql from '../db.js';

/**
 * In-memory debounce cache to prevent duplicate notifications within 2 minutes
 */
const sentNotifCache = new Map();
const COOLDOWN_MS = 2 * 60 * 1000;

function cleanCache() {
  const now = Date.now();
  for (const [key, ts] of sentNotifCache.entries()) {
    if (now - ts > COOLDOWN_MS) {
      sentNotifCache.delete(key);
    }
  }
}

function shouldThrottle(key) {
  cleanCache();
  const now = Date.now();
  if (sentNotifCache.has(key) && (now - sentNotifCache.get(key) < COOLDOWN_MS)) {
    return true;
  }
  sentNotifCache.set(key, now);
  return false;
}

/**
 * Insert In-App Notification into notification_log (Non-blocking & Safe)
 */
export async function createUserNotification({
  userId = null,
  targetRole = null,
  title,
  message,
  link = null,
  channel = 'InApp',
  sentByAdminId = null
}) {
  const cacheKey = `${userId || 'admin'}_${targetRole || ''}_${title}_${link}`;
  if (shouldThrottle(cacheKey)) {
    return { throttled: true };
  }

  try {
    await sql`
      INSERT INTO notification_log (
        user_id,
        target_role,
        title,
        message,
        link,
        channel,
        sent_by_admin_id,
        is_read,
        sent_at,
        delivery_status
      ) VALUES (
        ${userId},
        ${targetRole},
        ${title},
        ${message},
        ${link},
        ${channel},
        ${sentByAdminId},
        FALSE,
        NOW(),
        'Sent'
      )
    `;
    return { success: true };
  } catch (err) {
    console.warn('[InAppNotification] Failed to insert notification_log (non-fatal):', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Insert Admin In-App Notification
 */
export async function createAdminNotification({
  title,
  message,
  link = '/admin/dashboard',
  channel = 'InApp'
}) {
  return createUserNotification({
    userId: null,
    targetRole: 'Admin',
    title,
    message,
    link,
    channel
  });
}

/**
 * Insert Investor In-App Notification
 */
export async function createInvestorNotification({
  investorId,
  title,
  message,
  link = '/investor/dashboard',
  type = 'info'
}) {
  if (!investorId) return { success: false };
  const cacheKey = `investor_${investorId}_${title}_${link}`;
  if (shouldThrottle(cacheKey)) return { throttled: true };

  try {
    await sql`
      INSERT INTO investor_notifications (
        investor_id,
        title,
        message,
        link,
        notification_type,
        is_read,
        created_at
      ) VALUES (
        ${investorId},
        ${title},
        ${message},
        ${link},
        ${type},
        FALSE,
        NOW()
      )
    `;
    return { success: true };
  } catch (err) {
    console.warn('[InAppNotification] Failed to insert investor_notifications (non-fatal):', err.message);
    return { success: false, error: err.message };
  }
}

/* =====================================================================
 * MULTI-PARTY BUSINESS DISPATCHERS (Matching user's exact requirements)
 * ===================================================================== */

/**
 * 1. PLOT BOOKING NOTIFICATIONS
 * - If Direct: Admin gets alert. Customer gets confirmation.
 * - If Team Member / Associate: Customer, Team Member, Associate, and Admin all get tailored notifications.
 * - If Self-Purchase: Only the purchaser gets notification.
 */
export function dispatchBookingInAppNotification(data = {}) {
  setImmediate(async () => {
    try {
      const {
        bookingId,
        bookingSerial,
        plotNumber,
        siteName,
        customerId,
        customerName = 'Customer',
        buyerRole = 'customer',
        soldByUserId,
        associateUserId,
        isDirectBooking = false,
        advanceAmount,
        basePrice
      } = data;

      const plotLabel = plotNumber ? `Plot ${plotNumber}` : 'Plot';
      const siteLabel = siteName ? `at ${siteName}` : '';
      const amountStr = advanceAmount ? `₹${Number(advanceAmount).toLocaleString('en-IN')}` : '';

      // A. Self-purchase (Team member or associate buying for themselves)
      if (buyerRole === 'team_member' || buyerRole === 'associate') {
        const destLink = buyerRole === 'team_member' ? '/team-member/my-plots' : '/associate/my-plots';
        if (customerId) {
          await createUserNotification({
            userId: customerId,
            targetRole: buyerRole,
            title: '🏡 Your Plot Allotment Confirmed!',
            message: `${plotLabel} ${siteLabel} has been booked under your self-ownership. Advance: ${amountStr}.`,
            link: destLink
          });
        }
        await createAdminNotification({
          title: `🏡 Self-Purchase Plot Booking - ${plotLabel}`,
          message: `${customerName} (${buyerRole}) booked ${plotLabel} ${siteLabel} for self. Advance: ${amountStr}.`,
          link: '/admin/plot-orders'
        });
        return;
      }

      // B. Customer Booking Confirmation
      if (customerId) {
        await createUserNotification({
          userId: customerId,
          targetRole: 'Customer',
          title: '🎉 Plot Booking Confirmed!',
          message: `Congratulations! ${plotLabel} ${siteLabel} has been booked successfully. Booking Ref: ${bookingSerial || bookingId || 'N/A'}.`,
          link: '/user/my-plots'
        });
      }

      // C. Team Member (Sponsor/Seller) Notification
      if (soldByUserId) {
        await createUserNotification({
          userId: soldByUserId,
          targetRole: 'TeamMember',
          title: `💼 New Plot Booking in Your Team! (${plotLabel})`,
          message: `Your customer ${customerName} has booked ${plotLabel} ${siteLabel}. Advance: ${amountStr}. Commission calculated.`,
          link: '/team-member/sales'
        });
      }

      // D. Associate (Channel Partner) Notification
      if (associateUserId && associateUserId !== soldByUserId) {
        await createUserNotification({
          userId: associateUserId,
          targetRole: 'Associate',
          title: `🚀 Network Sale Alert - ${plotLabel}`,
          message: `New booking in your channel network: ${plotLabel} ${siteLabel} booked by ${customerName}.`,
          link: '/associate/my-team'
        });
      }

      // E. Admin Notification
      const sourceDesc = isDirectBooking || !soldByUserId ? 'Direct Booking' : 'Team Booking';
      await createAdminNotification({
        title: `🎉 New Plot Booking (${sourceDesc}) - ${plotLabel}`,
        message: `${customerName} booked ${plotLabel} ${siteLabel}. Advance: ${amountStr}. Ref: ${bookingSerial || bookingId || 'N/A'}.`,
        link: '/admin/plot-orders'
      });
    } catch (err) {
      console.warn('[InAppNotification] dispatchBookingInAppNotification error:', err.message);
    }
  });
}

/**
 * 2. WITHDRAWAL NOTIFICATIONS (Request, Release with UTR, Reject)
 */
export function dispatchWithdrawalInAppNotification(data = {}) {
  setImmediate(async () => {
    try {
      const {
        eventType, // 'request' | 'release' | 'reject'
        withdrawalId,
        userId,
        investorId,
        role = 'User',
        userName = 'User',
        amount,
        utrNo,
        reason
      } = data;

      const formattedAmount = `₹${Number(amount || 0).toLocaleString('en-IN')}`;

      // User target link based on role
      let userLink = '/user/wallet';
      if (role === 'investor' || investorId) userLink = '/investor/withdrawal';
      else if (role === 'associate') userLink = '/associate/wallet';
      else if (role === 'team_member') userLink = '/team-member/wallet';

      if (eventType === 'request') {
        // User acknowledgment
        if (investorId) {
          await createInvestorNotification({
            investorId,
            title: '⏳ Withdrawal Request Submitted',
            message: `Your withdrawal request of ${formattedAmount} has been submitted for admin processing.`,
            link: userLink
          });
        } else if (userId) {
          await createUserNotification({
            userId,
            targetRole: role,
            title: '⏳ Withdrawal Request Submitted',
            message: `Your withdrawal request of ${formattedAmount} is submitted and awaiting admin approval.`,
            link: userLink
          });
        }

        // Admin alert
        await createAdminNotification({
          title: `⚠️ New Withdrawal Request - ${formattedAmount}`,
          message: `${userName} (${role}) requested a payout withdrawal of ${formattedAmount}.`,
          link: '/admin/withdrawal-requests'
        });
      } else if (eventType === 'release') {
        // Payout released
        const utrText = utrNo ? ` (UTR: ${utrNo})` : '';
        if (investorId) {
          await createInvestorNotification({
            investorId,
            title: '✅ Withdrawal Successful & Transferred',
            message: `${formattedAmount} has been transferred to your bank account${utrText}.`,
            link: userLink
          });
        } else if (userId) {
          await createUserNotification({
            userId,
            targetRole: role,
            title: '✅ Payout Withdrawal Processed',
            message: `${formattedAmount} has been transferred to your registered bank account${utrText}.`,
            link: userLink
          });
        }
      } else if (eventType === 'reject') {
        // Payout rejected
        const reasonText = reason ? `: ${reason}` : '';
        if (investorId) {
          await createInvestorNotification({
            investorId,
            title: '❌ Withdrawal Request Rejected',
            message: `Your withdrawal of ${formattedAmount} was rejected${reasonText}. Amount refunded to wallet.`,
            link: userLink,
            type: 'error'
          });
        } else if (userId) {
          await createUserNotification({
            userId,
            targetRole: role,
            title: '❌ Withdrawal Request Rejected',
            message: `Your withdrawal of ${formattedAmount} was rejected${reasonText}. Amount refunded to your wallet.`,
            link: userLink
          });
        }
      }
    } catch (err) {
      console.warn('[InAppNotification] dispatchWithdrawalInAppNotification error:', err.message);
    }
  });
}

/**
 * 3. COMMISSION SETTLEMENT RELEASE NOTIFICATIONS
 */
export function dispatchCommissionReleaseInAppNotification(data = {}) {
  setImmediate(async () => {
    try {
      const {
        userId,
        role = 'Associate',
        amount,
        plotNumber,
        siteName,
        settlementId
      } = data;

      if (!userId) return;

      const formattedAmount = `₹${Number(amount || 0).toLocaleString('en-IN')}`;
      const plotLabel = plotNumber ? ` for Plot ${plotNumber}` : '';
      const destLink = role === 'team_member' ? '/team-member/wallet' : '/associate/wallet';

      await createUserNotification({
        userId,
        targetRole: role,
        title: `💰 Commission Released - ${formattedAmount}`,
        message: `Admin has released ${formattedAmount} commission${plotLabel} directly to your wallet.`,
        link: destLink
      });
    } catch (err) {
      console.warn('[InAppNotification] dispatchCommissionReleaseInAppNotification error:', err.message);
    }
  });
}

/**
 * 4. PAYMENT / EMI RECEIPT & REJECTION NOTIFICATIONS
 */
export function dispatchPaymentInAppNotification(data = {}) {
  setImmediate(async () => {
    try {
      const {
        status, // 'approved' | 'rejected' | 'submitted'
        paymentId,
        receiptNo,
        plotNumber,
        siteName,
        customerId,
        customerName = 'Customer',
        soldByUserId,
        associateUserId,
        amount,
        rejectionReason
      } = data;

      const formattedAmount = `₹${Number(amount || 0).toLocaleString('en-IN')}`;
      const plotLabel = plotNumber ? `Plot ${plotNumber}` : 'Plot';

      if (status === 'approved') {
        // Customer receipt notification
        if (customerId) {
          await createUserNotification({
            userId: customerId,
            targetRole: 'Customer',
            title: `🧾 Payment Receipt Generated - ${receiptNo || 'REC'}`,
            message: `Payment of ${formattedAmount} for ${plotLabel} approved. Official receipt is ready for download.`,
            link: '/user/emi-history'
          });
        }

        // Team Member alert
        if (soldByUserId) {
          await createUserNotification({
            userId: soldByUserId,
            targetRole: 'TeamMember',
            title: `💵 EMI Payment Received - ${plotLabel}`,
            message: `${customerName} paid installment of ${formattedAmount} for ${plotLabel}.`,
            link: '/team-member/commissions'
          });
        }

        // Associate alert
        if (associateUserId && associateUserId !== soldByUserId) {
          await createUserNotification({
            userId: associateUserId,
            targetRole: 'Associate',
            title: `💵 Network EMI Paid - ${plotLabel}`,
            message: `${customerName} completed payment of ${formattedAmount} for ${plotLabel}.`,
            link: '/associate/commissions'
          });
        }

        // Admin alert
        await createAdminNotification({
          title: `💳 Payment Approved - ${formattedAmount} (${plotLabel})`,
          message: `Payment of ${formattedAmount} for ${plotLabel} (${customerName}) approved and ledger allocated.`,
          link: '/admin/emi-payments'
        });
      } else if (status === 'rejected') {
        // Customer payment rejected
        if (customerId) {
          await createUserNotification({
            userId: customerId,
            targetRole: 'Customer',
            title: `⚠️ Payment Verification Failed - ${plotLabel}`,
            message: `Your payment of ${formattedAmount} was not approved: ${rejectionReason || 'Verification failed'}. Please check details.`,
            link: '/user/emi-history'
          });
        }
      }
    } catch (err) {
      console.warn('[InAppNotification] dispatchPaymentInAppNotification error:', err.message);
    }
  });
}

/**
 * 5. ENROLLMENT & ACCOUNT APPROVAL / REJECTION NOTIFICATIONS
 */
export function dispatchEnrollmentInAppNotification(data = {}) {
  setImmediate(async () => {
    try {
      const {
        enrollmentType, // 'Customer' | 'Associate' | 'TeamMember' | 'Investor'
        userId,
        investorId,
        userName = 'Applicant',
        status, // 'submitted' | 'approved' | 'rejected'
        reason
      } = data;

      if (status === 'submitted') {
        await createAdminNotification({
          title: `👤 New ${enrollmentType} Enrollment`,
          message: `${userName} has submitted a new ${enrollmentType} enrollment application for review.`,
          link: '/admin/enrollments'
        });
      } else if (status === 'approved') {
        let destLink = '/user/dashboard';
        if (enrollmentType === 'Associate') destLink = '/associate/dashboard';
        else if (enrollmentType === 'TeamMember') destLink = '/team-member/dashboard';
        else if (enrollmentType === 'Investor') destLink = '/investor/dashboard';

        if (investorId) {
          await createInvestorNotification({
            investorId,
            title: '✨ Account Approved & Activated!',
            message: 'Your investor account has been verified and approved by MMR Administration.',
            link: destLink
          });
        } else if (userId) {
          await createUserNotification({
            userId,
            targetRole: enrollmentType,
            title: '✨ Welcome to MMR Constructions!',
            message: `Congratulations! Your ${enrollmentType} application has been approved. You now have full access.`,
            link: destLink
          });
        }
      } else if (status === 'rejected') {
        if (userId) {
          await createUserNotification({
            userId,
            targetRole: enrollmentType,
            title: 'Application Status Update',
            message: `Your ${enrollmentType} application was not approved. Reason: ${reason || 'Details could not be verified.'}`,
            link: '/user/dashboard'
          });
        }
      }
    } catch (err) {
      console.warn('[InAppNotification] dispatchEnrollmentInAppNotification error:', err.message);
    }
  });
}

/**
 * 6. INVESTOR DEPOSIT NOTIFICATIONS
 */
export function dispatchInvestorDepositInAppNotification(data = {}) {
  setImmediate(async () => {
    try {
      const {
        eventType, // 'request' | 'approved' | 'rejected'
        investorId,
        investorName = 'Investor',
        amount,
        reason
      } = data;

      const formattedAmount = `₹${Number(amount || 0).toLocaleString('en-IN')}`;

      if (eventType === 'request') {
        if (investorId) {
          await createInvestorNotification({
            investorId,
            title: '💎 Deposit Request Submitted',
            message: `Your deposit request of ${formattedAmount} has been received for admin verification.`,
            link: '/investor/deposit'
          });
        }
        await createAdminNotification({
          title: `💎 New Investor Deposit - ${formattedAmount}`,
          message: `${investorName} submitted a new deposit request of ${formattedAmount} awaiting verification.`,
          link: '/admin/investors-portal'
        });
      } else if (eventType === 'approved') {
        if (investorId) {
          await createInvestorNotification({
            investorId,
            title: '✅ Deposit Approved & Portfolio Active',
            message: `${formattedAmount} has been successfully verified and credited to your investment principal portfolio.`,
            link: '/investor/transactions'
          });
        }
      } else if (eventType === 'rejected') {
        if (investorId) {
          await createInvestorNotification({
            investorId,
            title: '❌ Deposit Request Rejected',
            message: `Your deposit request of ${formattedAmount} was rejected: ${reason || 'Verification failed.'}`,
            link: '/investor/deposit',
            type: 'error'
          });
        }
      }
    } catch (err) {
      console.warn('[InAppNotification] dispatchInvestorDepositInAppNotification error:', err.message);
    }
  });
}

/**
 * 7. PLOT REGISTRY & DEED COMPLETED (Mark Sold)
 */
export function dispatchPlotRegistryInAppNotification(data = {}) {
  setImmediate(async () => {
    try {
      const {
        bookingId,
        customerId,
        customerName = 'Customer',
        plotNumber,
        siteName,
        registryNo
      } = data;

      const plotLabel = plotNumber ? `Plot ${plotNumber}` : 'Plot';
      const siteLabel = siteName ? `at ${siteName}` : '';

      if (customerId) {
        await createUserNotification({
          userId: customerId,
          targetRole: 'Customer',
          title: '🏆 Plot Registry & Ownership Complete!',
          message: `Congratulations! Official Registry Deed No: ${registryNo || 'Recorded'} for ${plotLabel} ${siteLabel} is complete.`,
          link: '/user/my-plots'
        });
      }

      await createAdminNotification({
        title: `📜 Plot Registry Recorded - ${plotLabel}`,
        message: `${plotLabel} ${siteLabel} for ${customerName} recorded with Deed No: ${registryNo || 'N/A'}. Unit officially marked Sold.`,
        link: '/admin/plot-orders'
      });
    } catch (err) {
      console.warn('[InAppNotification] dispatchPlotRegistryInAppNotification error:', err.message);
    }
  });
}

/**
 * 8. BOOKING CANCELLATION & REFUND
 */
export function dispatchBookingCancellationInAppNotification(data = {}) {
  setImmediate(async () => {
    try {
      const {
        bookingId,
        customerId,
        customerName = 'Customer',
        plotNumber,
        siteName,
        reason
      } = data;

      const plotLabel = plotNumber ? `Plot ${plotNumber}` : 'Plot';

      if (customerId) {
        await createUserNotification({
          userId: customerId,
          targetRole: 'Customer',
          title: 'Plot Booking Cancelled & Refund Due',
          message: `Booking for ${plotLabel} has been cancelled. Reason: ${reason || 'Requested'}. Refund is being processed.`,
          link: '/user/my-plots'
        });
      }
    } catch (err) {
      console.warn('[InAppNotification] dispatchBookingCancellationInAppNotification error:', err.message);
    }
  });
}

