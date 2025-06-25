import alchemy from "alchemy";
import { DOStateStore, Website } from "alchemy/cloudflare";
import { GitHubComment } from "alchemy/github";

const app = await alchemy("alchemy:website", {
  stateStore: (scope) => new DOStateStore(scope),
  stage: process.env.PULL_REQUEST ?? "dev",
});

const website = await Website("alchemy-website-test", {
  command: "bun run build",
  assets: "dist",
  wrangler: false,
  version: process.env.PULL_REQUEST,
});

if (process.env.PULL_REQUEST) {
  await GitHubComment("alchemy-website-test", {
    owner: "sam-goodwin",
    repository: "alchemy",
    issueNumber: Number(process.env.PULL_REQUEST),
    body: `Website deployed to ${website.url}`,
  });
}

console.log(website.url);

await app.finalize();
