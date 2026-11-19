// Runs during the snapshot build: proves the build context was uploaded and
// the build ARG reached the Dockerfile.
const fs = require("node:fs");

const greeting = fs.readFileSync("/opt/app/greeting", "utf8").trim();
if (greeting !== "from-alchemy") {
  console.error(`expected the GREETING build arg "from-alchemy", got "${greeting}"`);
  process.exit(1);
}
