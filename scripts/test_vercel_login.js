async function testVercelLogin() {
  const url = "https://mmrcontructions-api-self.vercel.app/api/admin/auth/login";
  const body = {
    email: "admin@mmrconstructions.in",
    password: "admin123"
  };

  try {
    console.log("Sending POST request to:", url);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const status = res.status;
    const json = await res.json();
    console.log("Response Status:", status);
    console.log("Response Body:", JSON.stringify(json, null, 2));
  } catch (err) {
    console.error("Fetch Error:", err);
  }
}

testVercelLogin();
