/// <reference types="node" />

import alchemy from "alchemy";
import { DOStateStore, ReactRouter } from "alchemy/cloudflare";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "";
const app = await alchemy("cloudflare-react-router", {
  stateStore:
    process.env.ALCHEMY_STATE_STORE === "cloudflare"
      ? (scope) => new DOStateStore(scope)
      : undefined,
});

export const website = await ReactRouter(
  `cloudflare-react-router-website${BRANCH_PREFIX}`,
  {
    main: "./workers/app.ts",
    command: "bun run build",
  },
);

console.log({
  url: website.url,
});

await app.finalize();
