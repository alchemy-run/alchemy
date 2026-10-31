// Reports the trust this process started with, then stays alive like a dev
// server so the resource becomes ready.
const fs = require("node:fs");

const bundle = process.env.NODE_EXTRA_CA_CERTS;
fs.writeFileSync(
  process.env.DEV_TRUST_OUT,
  JSON.stringify({
    contributed: process.env.ALCHEMY_DEV_TRUST,
    bundle,
    certificates: bundle ? fs.readFileSync(bundle, "utf8") : undefined,
  }),
);

console.log("http://localhost:65535/");
setInterval(() => {}, 60_000);
