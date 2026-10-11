# MMR CONSTRUCTIONS: TEAM MEMBER ID RECONCILIATION PLAN

**Document Version:** 1.0.0  
**Status:** PROPOSED & READ-ONLY (No mutations are executed without explicit business sign-off)  
**Author:** DeepMind Antigravity Engineering  
**Scope:** Strategy to reconcile historical records having mixed formats (`MMR-TM-00001` 5-digit vs `MMR-TM-0001` 4-digit) or legacy `MMR-ASC-` prefixes assigned to Team Members.

---

## 1. Executive Context & Objective

Prior to the canonical ID generator fix:
1. Public signup incorrectly generated `MMR-ASC-` format IDs for Team Members due to frontend overrides and backend whitelist restrictions.
2. Older Team Member registrations generated 5-digit sequence IDs (`MMR-TM-00001` through `MMR-TM-00005`).
3. The new standardized format is strictly **4 digits zero-padded**: `MMR-TM-0001`, `MMR-TM-0002`, etc.

The new generator safely calculates `MAX(tail) + 1` across both formats so that **future IDs continue seamlessly without colliding with either 4-digit or 5-digit numbers**.

However, historical records in the production database may contain:
- Existing active Team Members with `MMR-TM-0000X` (5-digit).
- Existing Team Members whose user record still holds `MMR-ASC-XXXX`.

This document details how these records can be reconciled safely in a future phase without breaking live logins, referral links, documents, invoices, or team hierarchy trees.

---

## 2. Impact Surface of Mutating Existing IDs

Modifying an existing `member_id` or `team_member_uid` in-place carries severe cascading risks if done carelessly:

| Module / Artifact | Risk If Mutated In-Place | Mitigation Strategy |
| :--- | :--- | :--- |
| **Referral / Invite Links** | Existing printed flyers, WhatsApp shares, or saved links using `?ref=MMR-ASC-0005` or `?ref=MMR-TM-00005` will 404 or fail sponsor resolution. | Implement **Legacy Alias Column** (`legacy_member_id`) so old codes resolve forever. |
| **Signed PDFs & Receipts** | Generated payment receipts, allotment letters, and KYC PDFs contain printed IDs. In-place changes create a discrepancy with physical documents. | Preserve original ID in immutable document audit history; issue addendum if requested. |
| **Authentication & Tokens** | Existing active JWT tokens or local storage keys caching old IDs might experience session invalidation. | Token authentication uses `user_id` (numeric primary key), but frontend displays `member_id`. Re-login seamlessly picks up new ID. |
| **Network & Sponsor Trees** | `mlm_tree_closure` and `referral_registrations` key on `user_id` (integer FK), but reporting and search filters query `member_id`. | Since foreign keys use `user_id`, tree relationships remain structurally intact. |
| **Bookings & Attributions** | `bookings.sold_by_user_id` and `bookings.associate_user_id` use integer `user_id`. Notes field may reference the string ID. | Relational integrity remains intact; notes text remains historical log. |

---

## 3. Recommended Technical Approach: Legacy Alias Table / Column

Rather than destructive in-place overwriting without an audit trail, the recommended strategy uses a **Non-Destructive Dual-Identity Architecture**:

### Option A (Recommended): Add `legacy_member_id` Column to `users`
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_member_id VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_users_legacy_member_id ON users(UPPER(legacy_member_id));
```

#### How it works:
1. When a user's ID is migrated from `MMR-TM-00005` to `MMR-TM-0005` (or from `MMR-ASC-0012` to `MMR-TM-0012`):
   - `users.legacy_member_id` stores the old value (`MMR-TM-00005` or `MMR-ASC-0012`).
   - `users.member_id` is updated to the new canonical format (`MMR-TM-0005`).
   - `team_members.team_member_uid` is synchronized to match `users.member_id`.
2. The shared referral resolver (`services/referralResolver.service.js`) checks:
   ```sql
   WHERE UPPER(member_id) = ${code}
      OR UPPER(invitation_code) = ${code}
      OR UPPER(legacy_member_id) = ${code}
   ```
3. **Result:** Old referral links and old printed cards **continue working indefinitely**, while all dashboards, leaderboards, and new documents display the clean canonical `MMR-TM-0005`.

---

## 4. Phase-by-Phase Execution Roadmap (For Future Sign-Off)

### Phase 1: Audit & Discovery (Zero Mutations)
- Run `scripts/team_member_id_format_check.sql` in production.
- Extract the exact list of affected `user_id`s, current `member_id`, current `team_member_uid`, and `user_type`.
- Review the list with business stakeholders.

### Phase 2: Schema Preparation
- Run Knex migration adding `legacy_member_id` to `users` and index.
- Update `referralResolver.service.js` to accept `legacy_member_id` in code lookups.

### Phase 3: Controlled Data Reconciliation
- For affected Team Members:
  - Copy current `member_id` into `legacy_member_id`.
  - Normalize `users.member_id` and `team_members.team_member_uid` to `MMR-TM-` + 4-digit zero-padded number.
  - Set `users.user_type = 'Team Member'`.
- Execute inside an isolated transaction with `SET LOCAL lock_timeout = '5s'`.

### Phase 4: Verification & Smoke Test
- Test login with affected Team Member account.
- Test referral signup using BOTH new ID and legacy ID.
- Verify Admin Team Members directory displays updated records correctly.

---

## 5. Summary Policy Decision Required from MMR Management

Before executing any data changes on historical rows, management confirmation is needed on:
1. **Should 5-digit IDs (`MMR-TM-00001`..`00005`) be converted to 4 digits (`MMR-TM-0001`..`0005`), or left as-is since the generator already continues safely from `0006`?**
   - *Engineering Recommendation:* Leaving them as-is or adopting Option A with aliases is 100% safe.
2. **For Team Members currently having `MMR-ASC-XXXX` IDs:**
   - Should their primary displayed ID be changed to `MMR-TM-XXXX` with `MMR-ASC-XXXX` kept as an alias?
   - *Engineering Recommendation:* Yes, migrate to `MMR-TM-XXXX` with Option A alias so old links continue functioning.
