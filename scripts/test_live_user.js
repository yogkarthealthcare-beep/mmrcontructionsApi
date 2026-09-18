async function test() {
  console.log("=== TESTING LIVE API LOGIN FOR test13@gmail.com ===");

  // 1. Test /api/auth/login
  try {
    const res1 = await fetch("https://api.mmrconstructions.in/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "test13@gmail.com", email: "test13@gmail.com", password: "Mmr@123456" })
    });
    const data1 = await res1.json();
    console.log("1. /api/auth/login Status:", res1.status, data1);
  } catch (e) {
    console.error("1. /api/auth/login Error:", e.message);
  }

  // 2. Test /api/investor/login
  try {
    const res2 = await fetch("https://api.mmrconstructions.in/api/investor/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "test13@gmail.com", email: "test13@gmail.com", password: "Mmr@123456" })
    });
    const data2 = await res2.json();
    console.log("2. /api/investor/login Status:", res2.status, data2);
  } catch (e) {
    console.error("2. /api/investor/login Error:", e.message);
  }

  // 3. Test /api/auth/send-otp for test13@gmail.com
  try {
    const res3 = await fetch("https://api.mmrconstructions.in/api/auth/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mobile_no: "test13@gmail.com", purpose: "Login" })
    });
    const data3 = await res3.json();
    console.log("3. /api/auth/send-otp Status:", res3.status, data3);
  } catch (e) {
    console.error("3. /api/auth/send-otp Error:", e.message);
  }
}

test();
