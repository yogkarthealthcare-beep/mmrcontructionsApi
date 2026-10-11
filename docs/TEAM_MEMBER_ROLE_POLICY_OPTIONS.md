# MMR Construction & Developers Pvt. Ltd.
# Architectural Policy Options: Team Member vs Associate Role Conflict Resolution

**Document Path:** `docs/TEAM_MEMBER_ROLE_POLICY_OPTIONS.md`  
**Date:** October 2026  
**Status:** **Architectural & Business Options Document (No code changes implemented)**  

---

## 1. Executive Summary & Problem Context

In MLM and sales network platforms, role hierarchy dictates commission flows, booking attribution, downline structures, and portal access.

A core real-world conflict arises when an individual who is already an **Associate** (e.g. "Golu Master" `MMR-ASC-00006`, with their own potential sponsor, downlines, and customer base) is enrolled by another Associate (e.g. Suraj Kumar Verma) into one of their 11 **Team Member** slots.

In the database, a single user record exists in `users` with `user_type = 'Associate'`, but a row also exists in `team_members` linking `user_id` to the sponsoring associate.

This document details the **3 structural business options** to resolve this conflict, detailing the precise impacts on Member IDs, Referral Links, Commission Calculations, Enrollment Status, and Booking Attribution.

---

## 2. Option Comparison Matrix

| Impact Dimension | Option 1: Exclusive Single Role | Option 2: Two Distinct Accounts (Recommended) | Option 3: Unified Role Switcher |
| :--- | :--- | :--- | :--- |
| **User Experience** | Single login; loses former role | Two separate logins (different mobile/email) | Single login; top-bar "Switch Panel" toggle |
| **Database Architecture** | Simple: 1 user, 1 role | Simple & Robust: 2 distinct `user_id` records | Highly complex: 1 user with polymorphic scopes |
| **Referral Link Integrity** | ⚠️ High risk of breaking old links | ✅ 100% Preserved & Isolated | ⚠️ Ambiguous: which referral link is being shared? |
| **MLM Commission Matrix** | ⚠️ What happens to former downlines? | ✅ Completely clear, clean, and separated | ⚠️ Requires dual commission ledger & split wallets |
| **Booking Attribution** | Unambiguous (attributes to new sponsor) | Pristine: depends on which account books | Dependent on active session context |
| **Implementation Effort** | Low (Business data migration required) | Low (Administrative policy guideline) | Very High (Requires complete architectural overhaul) |

---

## 3. Detailed Option Analysis

### Option 1: Strict Single Role per Account (Conversion Policy)
**Concept:** A user account can strictly hold only ONE active role in the system.
* **Mechanism:** If an Associate agrees to become a Team Member under another Associate:
  1. Their account `users.user_type` is converted to `'Team Member'`.
  2. Their independent Associate enrollment is archived or frozen.
* **Impact on ID & Referral Codes:**
  - Their old `MMR-ASC-` ID cannot remain their active referrer code without creating commission paradoxes.
  - New referral links must use their new Team Member UID (`MMR-TM-`).
* **Impact on Commissions & Downlines:**
  - **Critical Business Question:** If this Associate already has downlines or recurring commissions, what happens to them? Do they roll up to their former sponsor, or become orphaned?
* **Impact on Booking Attribution:**
  - When they book a plot, `sold_by_user_id` is set to them, and `associate_user_id` is permanently assigned to their new sponsor.

---

### Option 2: Two Distinct Accounts (Separate Logins / Credentials) — RECOMMENDED
**Concept:** If an individual wants to participate in two different capacities in the company, they must register two separate accounts with distinct credentials (e.g. mobile number or email).
* **Mechanism:**
  - **Account A (Associate Portal):** `user_id = 101`, Mobile = `9876543210`, Role = `Associate`, ID = `MMR-ASC-00006`.
  - **Account B (Team Member Portal):** `user_id = 205`, Mobile = `9876543219` (or secondary mobile/email), Role = `Team Member`, ID = `MMR-TM-00042`.
* **Why this is Recommended:**
  1. **Zero Data Corruption:** Database tables (`users`, `associate_enrollment`, `team_members`, `bookings`, `commissions`) remain completely normalized.
  2. **Zero Referral Conflicts:** When Golu shares his Associate link, it signs customers under his Associate team. When he works as a Team Member, his sponsor's attribution applies.
  3. **Zero Commission Ambiguity:** No split-wallet or ledger merging required.
  4. **Production Stability:** Requires zero risky code rewrites or schema hacks.

---

### Option 3: Single Login with Panel/Role Switcher
**Concept:** A single login credential with a role switcher header (e.g. "Currently acting as: Associate | Switch to Team Member").
* **Mechanism:**
  - The JWT token contains an `active_role` claim.
  - When switched to Associate, the user sees `/associate/*` with their Associate data.
  - When switched to Team Member, the user sees `/team-member/*` with their Team Member data.
* **Impacts & Caveats:**
  - Requires dynamic session state, split navigation guards, and dual wallet ledgers.
  - Highly error-prone for sales reps in the field who may accidentally book under the wrong panel context, leading to commission disputes.

---

## 4. Summary Recommendation for MMR Management

Unless MMR Constructions explicitly requires multi-role single-sign-on (Option 3), **Option 2 (Two Distinct Accounts)** is the standard industry best practice for network marketing and real estate platforms. It prevents commission leakage, maintains legal and financial transparency, and avoids complex technical regressions.
