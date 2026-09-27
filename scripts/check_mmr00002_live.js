import jwt from 'jsonwebtoken';
import '../config/loadEnv.js';

const JWT_SECRET = process.env.JWT_SECRET || 'mmrcontruction123';
const adminToken = jwt.sign(
  { admin_id: 1, email: 'admin@mmrconstructions.in', full_name: 'Super Admin', role: 'SuperAdmin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const API_BASE = 'https://api.mmrconstructions.in';

async function check() {
  console.log('Searching for MMR00002 in live backend...');
  const headers = {
    'Authorization': `Bearer ${adminToken}`,
    'Content-Type': 'application/json'
  };

  // 1. Check /api/auth/verify-sponsor/MMR00002
  try {
    const res = await fetch(`${API_BASE}/api/auth/verify-sponsor/MMR00002`);
    const data = await res.json();
    console.log('1. Sponsor Verify MMR00002:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error querying /api/auth/verify-sponsor/MMR00002:', e.message);
  }

  // 2. Check /api/auth/verify-sponsor/MMR0002
  try {
    const res = await fetch(`${API_BASE}/api/auth/verify-sponsor/MMR0002`);
    const data = await res.json();
    console.log('2. Sponsor Verify MMR0002:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error querying /api/auth/verify-sponsor/MMR0002:', e.message);
  }

  // 3. Check /api/admin/users
  try {
    const res = await fetch(`${API_BASE}/api/admin/users?search=MMR00002`, { headers });
    const data = await res.json();
    console.log('3. Admin Users Search (search=MMR00002):', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error querying /api/admin/users:', e.message);
  }

  // 4. Check /api/admin/customer-enrollments
  try {
    const res = await fetch(`${API_BASE}/api/admin/customer-enrollments?search=MMR00002`, { headers });
    const data = await res.json();
    console.log('4. Admin Customer Enrollments Search:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error querying /api/admin/customer-enrollments:', e.message);
  }

  // 5. Check /api/admin/investors
  try {
    const res = await fetch(`${API_BASE}/api/admin/investors?search=MMR00002`, { headers });
    const data = await res.json();
    console.log('5. Admin Investors Search:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error querying /api/admin/investors:', e.message);
  }

  // 6. Check list of users to find MMR00002 / MMR0002
  try {
    const res = await fetch(`${API_BASE}/api/admin/users?limit=100`, { headers });
    const data = await res.json();
    const list = data.users || data.data || [];
    console.log(`6. Total Users returned: ${list.length}`);
    const found = list.filter(u => 
      String(u.member_id || '').includes('0002') || 
      String(u.sponsor_id || '').includes('0002') ||
      String(u.sponsor_invite_code || '').includes('0002') ||
      String(u.user_id || '') === '2'
    );
    console.log('Found user records related to 0002 / 2:', JSON.stringify(found, null, 2));
  } catch (e) {
    console.error('Error fetching admin users:', e.message);
  }

  // 7. Check list of customer enrollments
  try {
    const res = await fetch(`${API_BASE}/api/admin/customer-enrollments?limit=100`, { headers });
    const data = await res.json();
    const list = data.items || data.data || [];
    console.log(`7. Total Customer Enrollments returned: ${list.length}`);
    const found = list.filter(u => 
      String(u.application_no || '').includes('0002') || 
      String(u.associate_id || '').includes('0002') ||
      String(u.user_id || '') === '2'
    );
    console.log('Found customer enrollment records related to 0002 / 2:', JSON.stringify(found, null, 2));
  } catch (e) {
    console.error('Error fetching customer enrollments:', e.message);
  }

  // 8. Check list of investors
  try {
    const res = await fetch(`${API_BASE}/api/admin/investors?limit=100`, { headers });
    const data = await res.json();
    const list = data.investors || data.data || [];
    console.log(`8. Total Investors returned: ${list.length}`);
    const found = list.filter(u => 
      String(u.sponsor_invite_code || '').includes('0002') || 
      String(u.id || '') === '2'
    );
    console.log('Found investor records related to 0002 / 2:', JSON.stringify(found, null, 2));
  } catch (e) {
    console.error('Error fetching investors:', e.message);
  }
}

check();
