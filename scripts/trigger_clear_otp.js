import http from 'http';

async function callClearOtp() {
  const ports = [5000, 3000, 8080, 5001];

  for (const port of ports) {
    try {
      console.log(`Sending POST /api/auth/clear-otp-logs to http://127.0.0.1:${port}...`);
      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/api/auth/clear-otp-logs',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log(`[Port ${port} Response ${res.statusCode}]:`, data);
        });
      });

      req.on('error', (e) => {
        // ignore connection refused
      });

      req.end();
    } catch (e) {}
  }
}

callClearOtp();
