import { execSync } from "child_process";

try {
  const diff = execSync("git diff server.js", { encoding: "utf8" });
  const lines = diff.split("\n");
  const result = [];
  let currentFile = "";
  let header = "";
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      currentFile = line;
      result.push(line);
    } else if (line.startsWith("@@")) {
      result.push(line);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      if (result.length < 50) {
        result.push("  " + line.substring(0, 100));
      }
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (result.length < 50) {
        result.push("  " + line.substring(0, 100));
      }
    }
  }
  console.log(result.slice(0, 100).join("\n"));
} catch (e) {
  console.error("Error:", e.message);
}
