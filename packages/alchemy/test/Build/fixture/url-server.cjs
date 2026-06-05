// Fixture for DevCommand URL-extraction tests. Writes its PID + marker to
// PID_FILE (so the test can stop the process if needed), then prints whatever
// is in `URL_LINE` to stdout/stderr and stays alive.
//
// `URL_LINE`  -> printed verbatim to stdout (can include ANSI escapes).
// `URL_STREAM` -> "stdout" (default) or "stderr".
// `URL_DELAY_MS` -> how long to wait before printing (default 0). Lets the
//   test exercise extraction that happens after reconcile starts awaiting.
const fs = require("node:fs");

const pidFile = process.env.PID_FILE;
const marker = process.env.MARKER ?? "default";
const urlLine = process.env.URL_LINE;
const urlStream = process.env.URL_STREAM === "stderr" ? "stderr" : "stdout";
const urlDelayMs = Number(process.env.URL_DELAY_MS ?? 0);

if (!pidFile) {
  console.error("url-server.cjs: PID_FILE env var is required");
  process.exit(1);
}

fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, marker }));

if (urlLine) {
  setTimeout(() => {
    process[urlStream].write(`${urlLine}\n`);
  }, urlDelayMs);
}

setInterval(() => {}, 60_000);
