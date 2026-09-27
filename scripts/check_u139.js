import jwt from 'jsonwebtoken';
import '../config/loadEnv.js';

const JWT_SECRET = process.env.JWT_SECRET || 'mmrcontruction123';
const adminToken = jwt.sign(
  { admin_id: 1, email: 'admin@mmrconstructions.in', full_name: 'Super Admin', role: 'SuperAdmin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const API_BASE = 'https://api.mmrconstructions.in';

async function testQuery() {
  // Let's test calling /api/admin/users/139
  const res = await fetch(`${API_BASE}/api/admin/users/139`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const data = await res.json();
  console.log('User 139 full profile from API:', JSON.stringify(data, null, 2));
}

testQuery();
