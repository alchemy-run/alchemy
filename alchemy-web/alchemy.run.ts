import alchemy from "alchemy";
import { Worker, Zone } from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";

const POSTHOG_DESTINATION_HOST =
  process.env.POSTHOG_DESTINATION_HOST ?? "us.i.posthog.com";
const POSTHOT_ASSET_DESTINATION_HOST =
  process.env.POSTHOG_ASSET_DESTINATION_HOST ?? "us.i.posthog.com";
//* this is not a secret, its public
const POSTHOG_PROJECT_ID =
  process.env.POSTHOG_PROJECT_ID ??
  "phc_1ZjunjRSQE5ij2xv0ir2tATiewyR6hLssSIiKrGQlBi";
const ZONE = process.env.ZONE ?? "alchemy.run";
const POSTHOG_PROXY_HOST = `ph.${ZONE}`;

const stage = process.env.STAGE ?? process.env.PULL_REQUEST ?? "dev";

const app = await alchemy("alchemy:website", {
  stateStore: (scope) => new CloudflareStateStore(scope),
  stage,
});

const domain =
  stage === "prod" ? ZONE : stage === "dev" ? `dev.${ZONE}` : undefined;

const proxyBindings = {
  POSTHOG_DESTINATION_HOST: POSTHOG_DESTINATION_HOST,
  POSTHOT_ASSET_DESTINATION_HOST: POSTHOT_ASSET_DESTINATION_HOST,
};
export type PosthogProxy = Worker<typeof proxyBindings>;

if (stage === "prod") {
  await Zone("alchemy-run", {
    name: "alchemy.run",
  });

  await Worker("posthog-proxy", {
    adopt: true,
    name: "alchemy-posthog-proxy",
    entrypoint: "src/proxy.ts",
    domains: [POSTHOG_PROXY_HOST],
    bindings: proxyBindings,
  });
}


await app.finalize();
