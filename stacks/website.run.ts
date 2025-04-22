// ensure providers are registered (for deletion purposes)

import "../alchemy/src/cloudflare";
import "../alchemy/src/dns";
import "../alchemy/src/os";

import path from "node:path";
import alchemy from "../alchemy/src";
import {
  Assets,
  CustomDomain,
  DnsRecords,
  Worker,
  Zone,
} from "../alchemy/src/cloudflare";
import { ImportDnsRecords } from "../alchemy/src/dns";
import { Exec } from "../alchemy/src/os";
import options from "./env";

const app = await alchemy("alchemy:website", options);

const zone = await Zone("alchemy.run", {
  name: "alchemy.run",
  type: "full",
});

const { records } = await ImportDnsRecords("dns-records", {
  domain: "alchemy.run",
  bump: 2,
});

await DnsRecords("transfer-dns-records", {
  zoneId: zone.id,
  records: records.filter(
    (r) =>
      // cloudflare doesn't support SOA
      // @see https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-create-dns-record
      r.type !== "SOA"
  ),
});

await Exec("build-site", {
  command: "bun run --filter alchemy-web docs:build",
});

const staticAssets = await Assets("static-assets", {
  path: path.join("alchemy-web", ".vitepress", "dist"),
});

const site = await Worker("website", {
  name: "alchemy-website",
  url: true,
  bindings: {
    ASSETS: staticAssets,
  },
  assets: {
    html_handling: "auto-trailing-slash",
    // not_found_handling: "single-page-application",
    run_worker_first: false,
  },
  script: `
export default {
async fetch(request, env) {
  // return env.ASSETS.fetch(request);
  return new Response("Not Found", { status: 404 });
},
};
`,
});

console.log("Site URL:", site.url);

await CustomDomain("alchemy-web-domain", {
  name: "alchemy.run",
  zoneId: zone.id,
  workerName: site.name,
});

console.log(`https://alchemy.run`);

await app.finalize();
