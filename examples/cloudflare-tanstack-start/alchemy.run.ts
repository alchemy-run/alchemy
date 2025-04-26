import "../../alchemy/src/cloudflare";

import alchemy from "../../alchemy/src";
import { TanStackStart } from "../../alchemy/src/cloudflare";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "";

const app = await alchemy("cloudflare-tanstack", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

export const website = await TanStackStart(
  `cloudflare-tanstack-website${BRANCH_PREFIX}`
);

console.log({
  url: website.url,
});

await app.finalize();
