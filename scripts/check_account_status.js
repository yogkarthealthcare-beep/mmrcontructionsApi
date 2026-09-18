async function checkStatus() {
  console.log("=== CHECKING IF test13@gmail.com EXISTS ON LIVE SERVER ===");

  // Check 1: /api/auth/forgot-password
  try {
    const res = await fetch("https://api.mmrconstructions.in/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test13@gmail.com" })
    });
    const d = await res.json();
    console.log("Forgot Password (/api/auth/forgot-password):", res.status, d);
  } catch (e) {
    console.error("Error 1:", e.message);
  }

  // Check 2: Try register-quick to see if it says 'already registered'
  try {
    const res = await fetch("https://api.mmrconstructions.in/api/auth/register-quick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_type: "Investor",
        full_name: "Test 13",
        email: "test13@gmail.com",
        mobile_no: "9876543210",
        password: "Password@123",
        sponsor_invite_code: "MMR0001"
      })
    });
    const d = await res.json();
    console.log("Try register-quick for test13@gmail.com:", res.status, d);
  } catch (e) {
    console.error("Error 2:", e.message);
  }

  // Check 3: Check /api/investors list to see if test13 is in the investor list
  try {
    const res = await fetch("https://api.mmrconstructions.in/api/investors");
    const d = await res.json();
    const found = (d?.data || []).find(i => (i.email || '').includes('test13') || (i.name || '').toLowerCase().includes('test 13') || (i.name || '').toLowerCase().includes('test13'));
    console.log("Found in /api/investors list?", found || "No");
  } catch (e) {
    console.error("Error 3:", e.message);
  }
}

checkStatus();
