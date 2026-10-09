import jwt from 'jsonwebtoken';
import '../config/loadEnv.js';

const JWT_SECRET = process.env.JWT_SECRET;
const adminToken = jwt.sign(
  { admin_id: 1, email: 'admin@mmrconstructions.in', full_name: 'Super Admin', role: 'SuperAdmin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const userToken = jwt.sign(
  { user_id: 139, user_type: 'Associate', email: 'vikasdotme@gmail.com', mobile_no: '9455704921' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const API_BASE = 'https://api.mmrconstructions.in';

async function verify() {
  console.log('=== CHECKING DATA FOR VIKAS RAJPUT / MMR00002 ===\n');

  const adminHeaders = {
    'Authorization': `Bearer ${adminToken}`,
    'Content-Type': 'application/json'
  };

  const userHeaders = {
    'Authorization': `Bearer ${userToken}`,
    'Content-Type': 'application/json'
  };

  // 1. Check /api/associate-enrollment/me for Vikas Rajput
  try {
    const res = await fetch(`${API_BASE}/api/associate-enrollment/me`, { headers: userHeaders });
    const data = await res.json();
    console.log('1. /api/associate-enrollment/me (Status ' + res.status + '):', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('1. Error:', e.message);
  }

  // 2. Check /api/admin/users/139
  try {
    const res = await fetch(`${API_BASE}/api/admin/users/139`, { headers: adminHeaders });
    const data = await res.json();
    console.log('\n2. /api/admin/users/139 (Status ' + res.status + '):', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('2. Error:', e.message);
  }

  // 3. Check /api/admin/associate-enrollments
  try {
    const res = await fetch(`${API_BASE}/api/admin/associate-enrollments?search=9455704921`, { headers: adminHeaders });
    const data = await res.json();
    console.log('\n3. /api/admin/associate-enrollments for 9455704921 (Status ' + res.status + '):', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('3. Error:', e.message);
  }

  // 4. Check all associate enrollments
  try {
    const res = await fetch(`${API_BASE}/api/admin/associate-enrollments`, { headers: adminHeaders });
    const data = await res.json();
    console.log('\n4. All Associate Enrollments (Status ' + res.status + '):', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('4. Error:', e.message);
  }
}

verify();
