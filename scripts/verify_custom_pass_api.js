async function verifyLogin() {
  const urls = [
    "https://api.mmrconstructions.in/api/admin/auth/login",
    "https://mmrconstructions.in/api/admin/auth/login"
  ];
  const body = {
    email: "admin@mmrconstructions.in",
    password: "MMR@Admin123"
  };

  for (const url of urls) {
    try {
      console.log(`\nTesting URL: ${url}`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      console.log("Status:", res.status);
      console.log("Response text:", text.slice(0, 300));
    } catch (err) {
      console.error("Error for " + url + ":", err.message);
    }
  }
}

verifyLogin();
