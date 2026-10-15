/**
 * Comprehensive Blue Tick Verification Suite
 * Tests all 4 roles across all lifecycle states:
 * 1. Customer (Draft vs Final Submitted vs Approved)
 * 2. Associate (Registered vs Submitted/Pending vs Approved)
 * 3. Team Member (No record vs Pending vs Active/Approved)
 * 4. Investor (Email OTP only vs Pending Enrollment vs Approved Enrollment)
 * 5. VerifiedBadgeComponent evaluation matrix
 */

const assert = require('assert');

// Frontend VerifiedBadgeComponent evaluation logic mirrored for test verification
function evaluateBadgeComponent(inputs) {
  const { user, isVerified } = inputs;
  if (!user && (isVerified === undefined || isVerified === null)) return false;
  const u = user || {};

  const enrollStatus = String(
    u.enrollment_status ||
    u.enrollmentStatus ||
    u.enrollment_form_status ||
    u.app_status ||
    u.appStatus ||
    ''
  ).toLowerCase().trim();

  // Fail closed: enrollment_status '0' means enrollment form has not been completed
  if ((enrollStatus === '0' || enrollStatus === 'not_enrolled') && !u.is_final_submitted) {
    return false;
  }

  // 1. Direct explicit boolean / 1-or-0 check on input property
  if (isVerified !== undefined && isVerified !== null) {
    if (isVerified === false || isVerified === 0 || String(isVerified) === '0' || String(isVerified).toLowerCase() === 'false') {
      return false;
    }
    if (isVerified === true || isVerified === 1 || String(isVerified) === '1' || String(isVerified).toLowerCase() === 'true') {
      return true;
    }
  }

  // 2. Direct is_verified / isVerified on user object (1 = verified, 0 = unverified)
  const rawUserFlag = u.is_verified !== undefined && u.is_verified !== null
    ? u.is_verified
    : (u.isVerified !== undefined && u.isVerified !== null ? u.isVerified : null);

  if (rawUserFlag !== null) {
    if (rawUserFlag === false || rawUserFlag === 0 || String(rawUserFlag) === '0' || String(rawUserFlag).toLowerCase() === 'false') {
      return false;
    }
    if (rawUserFlag === true || rawUserFlag === 1 || String(rawUserFlag) === '1' || String(rawUserFlag).toLowerCase() === 'true') {
      return true;
    }
  }

  // 3. Fallback: check enrollment-specific submission or approval
  if (u.is_final_submitted === true || String(u.is_final_submitted) === 'true' || u.is_final_submitted === 1) {
    return true;
  }

  return enrollStatus === 'approved' || enrollStatus === 'completed';
}

// Backend projection logic simulation matching server.js & investor.routes.js
function projectBackendUser(u, enrollRecord) {
  const role = (u.user_type || '').toLowerCase();

  if (role === 'customer') {
    const ces = enrollRecord;
    const is_final = ces && Boolean(ces.is_final_submitted);
    const is_verified = Boolean(ces && ces.id && is_final);
    const enrollment_status = is_final ? 'Completed' : (ces && ces.id ? 'Submitted' : (u.enrollment_status || '0'));
    return { is_verified, enrollment_status, is_final_submitted: is_final };
  }

  if (role === 'associate') {
    const ae = enrollRecord;
    const isApproved = ae && ae.id && ['approved', 'completed'].includes(String(ae.status || '').toLowerCase());
    const is_verified = Boolean(isApproved);
    const enrollment_status = isApproved ? 'Completed' : (ae && ae.id ? (String(ae.status).toLowerCase() === 'rejected' ? 'Rejected' : 'Submitted') : '0');
    return { is_verified, enrollment_status };
  }

  if (role === 'team member') {
    const tm = enrollRecord;
    const isActiveOrApproved = tm && tm.id && ['approved', 'active'].includes(String(tm.status || '').toLowerCase());
    const is_verified = Boolean(isActiveOrApproved);
    const enrollment_status = isActiveOrApproved ? 'Completed' : '0';
    return { is_verified, enrollment_status };
  }

  if (role === 'investor') {
    const ie = enrollRecord;
    const isApproved = ie && ie.id && Boolean(ie.is_final_submitted) && String(ie.app_status || '').toLowerCase() === 'approved';
    const is_verified = Boolean(isApproved);
    const enrollment_status = isApproved ? 'Completed' : (ie && ie.id ? (String(ie.app_status).toLowerCase() === 'rejected' ? 'Rejected' : 'Submitted') : '0');
    return { is_verified, enrollment_status };
  }

  return { is_verified: false, enrollment_status: '0' };
}

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}:`, err.message);
  }
}

console.log("=================================================================");
console.log("       MMR CONSTRUCTIONS — BLUE TICK VERIFICATION SUITE          ");
console.log("=================================================================\n");

console.log("--- 1. Customer Enrollment Tests ---");
test("1.1 Customer without enrollment record -> Badge hidden", () => {
  const backend = projectBackendUser({ user_type: 'Customer', enrollment_status: '0' }, null);
  assert.strictEqual(backend.is_verified, false);
  assert.strictEqual(backend.enrollment_status, '0');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, false);
});

test("1.2 Customer with draft form (is_final_submitted = false) -> Badge hidden", () => {
  const backend = projectBackendUser({ user_type: 'Customer' }, { id: 'ces-1', is_final_submitted: false });
  assert.strictEqual(backend.is_verified, false);
  assert.strictEqual(backend.enrollment_status, 'Submitted');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, false);
});

test("1.3 Customer with final submission WITHOUT admin approval -> Badge VISIBLE (Rule 1)", () => {
  const backend = projectBackendUser({ user_type: 'Customer' }, { id: 'ces-2', is_final_submitted: true, application_status: 'Pending' });
  assert.strictEqual(backend.is_verified, true, "is_verified must be true upon final submission");
  assert.strictEqual(backend.enrollment_status, 'Completed');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, true, "Badge must be visible after final submission without admin approval");
});

test("1.4 Customer with final submission AND approved status -> Badge VISIBLE", () => {
  const backend = projectBackendUser({ user_type: 'Customer' }, { id: 'ces-3', is_final_submitted: true, application_status: 'Approved' });
  assert.strictEqual(backend.is_verified, true);
  assert.strictEqual(backend.enrollment_status, 'Completed');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, true);
});

console.log("\n--- 2. Associate Enrollment Tests ---");
test("2.1 Associate registered & account active, but NO enrollment form -> Badge hidden (Rule 2)", () => {
  const backend = projectBackendUser({ user_type: 'Associate', account_status: 'Active', is_verified: true, enrollment_status: '0' }, null);
  assert.strictEqual(backend.is_verified, false, "Account activation must never bypass enrollment requirement");
  assert.strictEqual(backend.enrollment_status, '0');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, false);
});

test("2.2 Associate with submitted form pending Admin approval (status = 'Pending') -> Badge hidden (Rule 2)", () => {
  const backend = projectBackendUser({ user_type: 'Associate' }, { id: 'ae-1', status: 'Pending', is_final_submitted: true });
  assert.strictEqual(backend.is_verified, false, "Pending admin approval must not show badge");
  assert.strictEqual(backend.enrollment_status, 'Submitted');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, false);
});

test("2.3 Associate with rejected form (status = 'Rejected') -> Badge hidden", () => {
  const backend = projectBackendUser({ user_type: 'Associate' }, { id: 'ae-2', status: 'Rejected' });
  assert.strictEqual(backend.is_verified, false);
  assert.strictEqual(backend.enrollment_status, 'Rejected');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, false);
});

test("2.4 Associate with Admin approved enrollment (status = 'approved') -> Badge VISIBLE (Rule 2)", () => {
  const backend = projectBackendUser({ user_type: 'Associate' }, { id: 'ae-3', status: 'approved', is_final_submitted: true });
  assert.strictEqual(backend.is_verified, true);
  assert.strictEqual(backend.enrollment_status, 'Completed');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, true);
});

console.log("\n--- 3. Team Member Verification Tests ---");
test("3.1 Team Member user without team_members table record -> Badge hidden (Rule 3)", () => {
  const backend = projectBackendUser({ user_type: 'Team Member', account_status: 'Active' }, null);
  assert.strictEqual(backend.is_verified, false);
  assert.strictEqual(backend.enrollment_status, '0');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, false);
});

test("3.2 Team Member with pending membership status -> Badge hidden", () => {
  const backend = projectBackendUser({ user_type: 'Team Member' }, { id: 10, status: 'pending' });
  assert.strictEqual(backend.is_verified, false);
  assert.strictEqual(backend.enrollment_status, '0');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, false);
});

test("3.3 Team Member with status = 'approved' -> Badge VISIBLE (Rule 3)", () => {
  const backend = projectBackendUser({ user_type: 'Team Member' }, { id: 11, status: 'approved' });
  assert.strictEqual(backend.is_verified, true);
  assert.strictEqual(backend.enrollment_status, 'Completed');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, true);
});

test("3.4 Team Member with status = 'active' -> Badge VISIBLE (Rule 3)", () => {
  const backend = projectBackendUser({ user_type: 'Team Member' }, { id: 12, status: 'active' });
  assert.strictEqual(backend.is_verified, true);
  assert.strictEqual(backend.enrollment_status, 'Completed');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, true);
});

console.log("\n--- 4. Investor Verification Tests ---");
test("4.1 Investor with email OTP verified (investor_users.is_verified = true) but NO enrollment -> Badge hidden (Rule 3)", () => {
  const backend = projectBackendUser({ user_type: 'Investor', is_verified: true, enrollment_status: '0' }, null);
  assert.strictEqual(backend.is_verified, false, "Email OTP verification must NOT show verified badge");
  assert.strictEqual(backend.enrollment_status, '0');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, false);
});

test("4.2 Investor with enrollment submitted but pending approval (app_status = 'Pending') -> Badge hidden", () => {
  const backend = projectBackendUser({ user_type: 'Investor' }, { id: 'ie-1', app_status: 'Pending', is_final_submitted: true });
  assert.strictEqual(backend.is_verified, false);
  assert.strictEqual(backend.enrollment_status, 'Submitted');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, false);
});

test("4.3 Investor with Admin approved enrollment (app_status = 'Approved') -> Badge VISIBLE", () => {
  const backend = projectBackendUser({ user_type: 'Investor' }, { id: 'ie-2', app_status: 'Approved', is_final_submitted: true });
  assert.strictEqual(backend.is_verified, true);
  assert.strictEqual(backend.enrollment_status, 'Completed');
  const badge = evaluateBadgeComponent({ user: backend });
  assert.strictEqual(badge, true);
});

console.log("\n--- 5. VerifiedBadgeComponent Property Input Overrides ---");
test("5.1 Explicit [isVerified]='true' -> Badge visible", () => {
  assert.strictEqual(evaluateBadgeComponent({ user: { enrollment_status: 'Completed' }, isVerified: true }), true);
});

test("5.2 Explicit [isVerified]='false' overrides user object -> Badge hidden", () => {
  assert.strictEqual(evaluateBadgeComponent({ user: { is_verified: true, enrollment_status: 'Completed' }, isVerified: false }), false);
});

test("5.3 Fail-closed: enrollment_status='0' suppresses badge", () => {
  assert.strictEqual(evaluateBadgeComponent({ user: { is_verified: true, enrollment_status: '0' } }), false);
});

console.log("\n=================================================================");
console.log(`TOTAL TESTS: ${total} | PASSED: ${passed} | FAILED: ${total - passed}`);
console.log("=================================================================");

if (passed === total) {
  console.log("\nALL VERIFICATION TESTS PASSED SUCCESSFULLY! (100% Correctness)");
  process.exit(0);
} else {
  console.error("\nTEST SUITE FAILED!");
  process.exit(1);
}
