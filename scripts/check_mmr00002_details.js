import jwt from 'jsonwebtoken';
import '../config/loadEnv.js';

const JWT_SECRET = process.env.JWT_SECRET || 'mmrcontruction123';
const adminToken = jwt.sign(
  { admin_id: 1, email: 'admin@mmrconstructions.in', full_name: 'Super Admin', role: 'SuperAdmin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const API_BASE = 'https://api.mmrconstructions.in';

async function checkDetails() {
  const headers = {
    'Authorization': `Bearer ${adminToken}`,
    'Content-Type': 'application/json'
  };

  // Check Customer enrollment details
  try {
    const res = await fetch(`${API_BASE}/api/admin/customer-enrollments/0f24c0cb-0585-4586-b977-1e8a48d1555a`, { headers });
    const data = await res.json();
    console.log('Customer Enrollment 0f24c0cb-0585-4586-b977-1e8a48d1555a:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
  }

  // Check User 139 details
  try {
    const res = await fetch(`${API_BASE}/api/admin/users/139`, { headers });
    const data = await res.json();
    console.log('User 139 (Associate):', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

checkDetails();
