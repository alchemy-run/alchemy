import alchemy from "alchemy";
import { Worker, Zone } from "alchemy/cloudflare";

const POSTHOG_DESTINATION_HOST =
  process.env.POSTHOG_DESTINATION_HOST ?? "us.i.posthog.com";
const POSTHOT_ASSET_DESTINATION_HOST =
  process.env.POSTHOG_ASSET_DESTINATION_HOST ?? "us.i.posthog.com";
const ZONE = alchemy.env.ZONE;
const POSTHOG_PROXY_HOST = `ph.${ZONE}`;

const app = await alchemy("cloudflare-posthog");

await Zone("alchemy-run", {
  name: "alchemy.run",
});

await Worker("posthog-proxy", {
  adopt: true,
  name: "alchemy-posthog-proxy",
  entrypoint: "src/proxy.ts",
  domains: [POSTHOG_PROXY_HOST],
  bindings: {
    POSTHOG_DESTINATION_HOST: POSTHOG_DESTINATION_HOST,
    POSTHOT_ASSET_DESTINATION_HOST: POSTHOT_ASSET_DESTINATION_HOST,
  },
});

await app.finalize();
