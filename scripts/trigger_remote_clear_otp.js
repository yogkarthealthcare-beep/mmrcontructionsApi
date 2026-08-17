import https from 'https';

async function triggerClearRemote() {
  console.log('Sending clear OTP request to live backend https://api.mmrconstructions.in/api/auth/clear-otp-logs ...');
  
  const req = https.request({
    hostname: 'api.mmrconstructions.in',
    path: '/api/auth/clear-otp-logs',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log(`[Status ${res.statusCode}]:`, data);
    });
  });

  req.on('error', (err) => {
    console.error('Request Error:', err.message);
  });

  req.end();
}

triggerClearRemote();
