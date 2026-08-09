const fs = require("node:fs");
const { spawn } = require("node:child_process");

const pidFile = process.env.PID_FILE;
if (!pidFile) throw new Error("PID_FILE is required");

process.on("SIGTERM", () => {});
const descendant = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"],
  {
    stdio: "ignore",
  },
);
fs.writeFileSync(
  pidFile,
  JSON.stringify({ pid: process.pid, descendantPid: descendant.pid }),
);
console.log("http://localhost:65535/");
setInterval(() => {}, 60_000);
