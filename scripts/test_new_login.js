async function testLogin() {
  console.log("=== TESTING LOGIN FOR test13@gmail.com WITH Password@123 ===");

  // 1. Test /api/auth/login
  const res1 = await fetch("https://api.mmrconstructions.in/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "test13@gmail.com", email: "test13@gmail.com", password: "Password@123" })
  });
  const data1 = await res1.json();
  console.log("1. /api/auth/login Status:", res1.status, data1);

  // 2. Test /api/investor/login
  const res2 = await fetch("https://api.mmrconstructions.in/api/investor/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "test13@gmail.com", email: "test13@gmail.com", password: "Password@123" })
  });
  const data2 = await res2.json();
  console.log("2. /api/investor/login Status:", res2.status, data2);
}

testLogin();
