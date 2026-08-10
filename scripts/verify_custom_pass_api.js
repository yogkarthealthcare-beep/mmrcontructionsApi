async function verifyLogin() {
  const url = "https://api.mmrconstructions.in/api/admin/auth/login";
  const body = {
    email: "admin@mmrconstructions.in",
    password: "MMR@Admin123"
  };

  try {
    console.log("Verifying live API login with new password MMR@Admin123...");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    console.log("Status:", res.status);
    console.log("Response:", JSON.stringify(json, null, 2));
  } catch (err) {
    console.error("Error:", err);
  }
}

verifyLogin();
