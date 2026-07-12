import { execSync } from "child_process";

try {
  const diff = execSync("git diff server.js", { encoding: "utf8" });
  console.log(diff);
} catch (e) {
  console.error("Error running git diff:", e.message);
}
