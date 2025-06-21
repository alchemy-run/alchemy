import alchemy from "alchemy";
import { DOStateStore, TanStackStart } from "alchemy/cloudflare";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "";

const app = await alchemy("cloudflare-tanstack", {
  stateStore:
    process.env.ALCHEMY_STATE_STORE === "cloudflare"
      ? (scope) => new DOStateStore(scope)
      : undefined,
});

export const website = await TanStackStart(
  `cloudflare-tanstack-website${BRANCH_PREFIX}`,
);

console.log({
  url: website.url,
});

await app.finalize();
