// Fixture for the dev trust tests in Dev.test.ts. Writes its PID + a marker,
// the NODE_EXTRA_CA_CERTS it started with, and what that file holds, then
// stays alive like a dev server.
const fs = require("node:fs");

const pidFile = process.env.PID_FILE;
const marker = process.env.MARKER ?? "default";
const bundle = process.env.NODE_EXTRA_CA_CERTS;

if (!pidFile) {
  console.error("trust-env.cjs: PID_FILE env var is required");
  process.exit(1);
}

fs.writeFileSync(
  pidFile,
  JSON.stringify({
    pid: process.pid,
    marker,
    bundle,
    certificates: bundle && fs.existsSync(bundle) ? fs.readFileSync(bundle, "utf8") : undefined,
  }),
);

console.log("http://localhost:65535/");

setInterval(() => {}, 60_000);
