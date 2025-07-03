import alchemy from "alchemy";
import { DOStateStore, Website } from "alchemy/cloudflare";
import { GitHubComment } from "alchemy/github";

const stage = process.env.PULL_REQUEST ?? process.env.STAGE ?? "dev";

const app = await alchemy("alchemy:website", {
  stateStore: (scope) => new DOStateStore(scope),
  stage,
});

const domain =
  stage === "prod"
    ? "alchemy.run"
    : stage === "dev"
      ? "dev.alchemy.run"
      : `pr-${process.env.PULL_REQUEST}.alchemy.run`;

const website = await Website("website", {
  name: "alchemy-website",
  command: "bun run build",
  assets: "dist",
  adopt: true,
  wrangler: false,
  version: stage === "prod" ? undefined : stage,
  domains: process.env.PULL_REQUEST ? undefined : [domain],
});

if (process.env.PULL_REQUEST) {
  await GitHubComment("comment", {
    owner: "sam-goodwin",
    repository: "alchemy",
    issueNumber: Number(process.env.PULL_REQUEST),
    body: `
## 🚀 Website Preview Deployed

Your website preview is ready! 

**Preview URL:** ${website.url}

This preview was built from commit ${process.env.GITHUB_SHA}

---
<sub>🤖 This comment will be updated automatically when you push new commits to this PR.</sub>`,
  });
}

console.log(domain ? `https://${domain}` : website.url);

await app.finalize();
