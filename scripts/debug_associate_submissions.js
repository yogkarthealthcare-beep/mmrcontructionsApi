import jwt from 'jsonwebtoken';
import '../config/loadEnv.js';

const JWT_SECRET = process.env.JWT_SECRET || 'mmrcontruction123';
const adminToken = jwt.sign(
  { admin_id: 1, email: 'admin@mmrconstructions.in', full_name: 'Super Admin', role: 'SuperAdmin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const API_BASE = 'https://api.mmrconstructions.in';

async function checkSubmissions() {
  const headers = {
    'Authorization': `Bearer ${adminToken}`,
    'Content-Type': 'application/json'
  };

  // 1. Check /api/admin/associate-enrollments
  try {
    const res = await fetch(`${API_BASE}/api/admin/associate-enrollments?limit=100`, { headers });
    const data = await res.json();
    console.log('1. /api/admin/associate-enrollments Response Status:', res.status);
    console.log('Data:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error querying /api/admin/associate-enrollments:', e.message);
  }

  // 2. Check user token for 9455704921 / vikasdotme@gmail.com to see what /api/associate-enrollment/me returns
  const userToken = jwt.sign(
    { user_id: 139, user_type: 'Associate', email: 'vikasdotme@gmail.com', mobile_no: '9455704921' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  try {
    const res = await fetch(`${API_BASE}/api/associate-enrollment/me`, {
      headers: { 'Authorization': `Bearer ${userToken}` }
    });
    const data = await res.json();
    console.log('\n2. /api/associate-enrollment/me for user 139 Status:', res.status);
    console.log('Data:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error querying /api/associate-enrollment/me:', e.message);
  }

  // 3. Test submitting associate enrollment for user 139 with a test payload to see if live server accepts it or what error it gives!
  const formData = new FormData();
  formData.append('fullName', 'Vikas Rajput');
  formData.append('dob', '1995-01-01');
  formData.append('gender', 'Male');
  formData.append('fatherName', 'Father Name');
  formData.append('motherName', 'Mother Name');
  formData.append('contact1', '9455704921');
  formData.append('nationality', 'Indian');
  formData.append('residentialStatus', 'Resident');
  formData.append('panNo', 'ABCDE1234F');
  formData.append('aadharNo', '123456789012');
  formData.append('email', 'vikasdotme@gmail.com');
  formData.append('occupation', 'Business');
  formData.append('annualIncome', '500000');
  formData.append('education', 'Graduate');
  formData.append('category', 'General');
  formData.append('religion', 'Hindu');
  formData.append('permAddress', 'Kanpur');
  formData.append('permCity', 'Kanpur');
  formData.append('permState', 'Uttar Pradesh');
  formData.append('permCountry', 'India');
  formData.append('permPin', '208001');
  formData.append('localAddress', 'Kanpur');
  formData.append('localCity', 'Kanpur');
  formData.append('localState', 'Uttar Pradesh');
  formData.append('localCountry', 'India');
  formData.append('localPin', '208001');
  formData.append('bankName', 'SBI');
  formData.append('accHolder', 'Vikas Rajput');
  formData.append('accNo', '1234567890');
  formData.append('ifsc', 'SBIN0001234');
  formData.append('branchName', 'Main Branch');
  formData.append('branchCountry', 'India');
  formData.append('nomineeName', 'Nominee');
  formData.append('nomineeDob', '1996-01-01');
  formData.append('nomineeGender', 'Female');
  formData.append('nomineeNationality', 'Indian');
  formData.append('nomineeRelationship', 'Spouse');
  formData.append('nomineeAddress', 'Kanpur');
  formData.append('sponsorName', 'Suraj Kumar Verma');
  formData.append('sponsorCode', 'MMR0001');
  formData.append('sponsorContact', '7071951011');
  formData.append('termsAccepted', 'true');
  formData.append('signDate', '2026-09-27');

  try {
    const res = await fetch(`${API_BASE}/api/associate-enrollment`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userToken}`
      },
      body: formData
    });
    const data = await res.json();
    console.log('\n3. Test POST /api/associate-enrollment for user 139 Status:', res.status);
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error posting test associate-enrollment:', e.message);
  }
}

checkSubmissions();
