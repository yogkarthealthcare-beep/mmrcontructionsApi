async function setPassword() {
  console.log("=== SETTING PASSWORD TO Mmr@123456 FOR test13@gmail.com ===");

  // 1. First login with Password@123 to get token
  const resLogin = await fetch("https://api.mmrconstructions.in/api/investor/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "test13@gmail.com", password: "Password@123" })
  });
  const dataLogin = await resLogin.json();
  console.log("Login with current password:", dataLogin.success);

  if (dataLogin.success && dataLogin.data?.token) {
    const token = dataLogin.data.token;
    // Call change password
    const resChange = await fetch("https://api.mmrconstructions.in/api/investor/change-password", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        current_password: "Password@123",
        new_password: "Mmr@123456"
      })
    });
    const dataChange = await resChange.json();
    console.log("Password change response:", resChange.status, dataChange);
  }

  // 2. Verify login with Mmr@123456 on both /api/auth/login and /api/investor/login
  console.log("\n--- VERIFYING LOGIN WITH Mmr@123456 ---");
  const res1 = await fetch("https://api.mmrconstructions.in/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "test13@gmail.com", email: "test13@gmail.com", password: "Mmr@123456" })
  });
  console.log("1. /api/auth/login Status:", res1.status, await res1.json());

  const res2 = await fetch("https://api.mmrconstructions.in/api/investor/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "test13@gmail.com", email: "test13@gmail.com", password: "Mmr@123456" })
  });
  console.log("2. /api/investor/login Status:", res2.status, await res2.json());
}

setPassword();
