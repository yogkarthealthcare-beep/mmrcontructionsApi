import jwt from 'jsonwebtoken';
import '../config/loadEnv.js';

const JWT_SECRET = process.env.JWT_SECRET || 'mmrcontruction123';
const adminToken = jwt.sign(
  { admin_id: 1, email: 'admin@mmrconstructions.in', full_name: 'Super Admin', role: 'SuperAdmin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const API_BASE = 'https://api.mmrconstructions.in';

async function checkUsers() {
  // Let's call /api/admin/users?limit=1 to see the exact keys returned for users table
  const res = await fetch(`${API_BASE}/api/admin/users?limit=1`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const data = await res.json();
  console.log('User sample:', JSON.stringify(data.users?.[0] || data.data?.[0], null, 2));
}

checkUsers();
