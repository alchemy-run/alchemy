import alchemy from "alchemy";
import { Astro, VersionMetadata, Worker, Zone } from "alchemy/cloudflare";
import { GitHubComment } from "alchemy/github";
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
}

const markdownRoutes = [
  "/advanced*",
  "/blog*",
  "/concepts*",
  "/guides*",
  "/providers*",
  "/telemetry*",
  "/getting-started*",
  "/what-is-alchemy*",
];

export const website = await Astro("website", {
  name: "alchemy-website",
  adopt: true,
  version: stage === "prod" ? undefined : stage,
  domains: domain ? [domain] : undefined,
  env: {
    POSTHOG_CLIENT_API_HOST: `https://${POSTHOG_PROXY_HOST}`,
    POSTHOG_PROJECT_ID: POSTHOG_PROJECT_ID,
    ENABLE_POSTHOG: stage === "prod" ? "true" : "false",
  },
  entrypoint: "src/router.ts",
  noBundle: false,
  assets: {
    directory: "dist",
    run_worker_first: markdownRoutes,
    _headers: markdownRoutes
      .flatMap((route) => [route, "  Vary: accept"])
      .join("\n"),
  },
  bindings: {
    VERSION: VersionMetadata(),
  },
});

const url = domain ? `https://${domain}` : website.url;

console.log(url);

if (process.env.PULL_REQUEST) {
  await GitHubComment("comment", {
    owner: "sam-goodwin",
    repository: "alchemy",
    issueNumber: Number(process.env.PULL_REQUEST),
    body: `
## 🚀 Website Preview Deployed

Your website preview is ready!

**Preview URL:** ${url}

This preview was built from commit ${process.env.GITHUB_SHA}

---
<sub>🤖 This comment will be updated automatically when you push new commits to this PR.</sub>`,
  });
}

await app.finalize();
