import express from "express";
import jwt from "jsonwebtoken";
import sql from "../db.js";

async function runTest() {
  const secret = "mmr_constructions_jwt_secret_2026_key";
  const token = jwt.sign({ admin_id: 1, email: "admin@mmrconstructions.in", full_name: "MMR Admin", role: "SuperAdmin" }, secret);

  const res = await fetch("http://localhost:5000/api/admin/login-as-user", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ user_id: 7, user_type: "Customer" })
  });

  console.log("Status:", res.status);
  console.log("Body:", await res.text());
  process.exit(0);
}

runTest();
