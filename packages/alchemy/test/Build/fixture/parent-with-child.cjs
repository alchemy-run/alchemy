const fs = require("node:fs");
const childProcess = require("node:child_process");

const parentFile = process.env.PARENT_PID_FILE;
const childFile = process.env.CHILD_PID_FILE;
const marker = process.env.MARKER ?? "default";

if (!parentFile || !childFile) {
  console.error(
    "parent-with-child.cjs: PARENT_PID_FILE and CHILD_PID_FILE env vars are required",
  );
  process.exit(1);
}

fs.writeFileSync(parentFile, JSON.stringify({ pid: process.pid, marker }));

const child = childProcess.spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 60000)"],
  {
    detached: false,
    stdio: "ignore",
  },
);

fs.writeFileSync(childFile, JSON.stringify({ pid: child.pid, marker }));

setInterval(() => {}, 60_000);
