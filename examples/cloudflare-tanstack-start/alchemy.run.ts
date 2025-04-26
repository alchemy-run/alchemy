import "../../alchemy/src/cloudflare";

import alchemy from "../../alchemy/src";
import { R2Bucket, TanStackStart } from "../../alchemy/src/cloudflare";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "";

const app = await alchemy("cloudflare-tanstack", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

const bucket = await R2Bucket(`cloudflare-tanstack-bucket${BRANCH_PREFIX}`);

export const website = await TanStackStart(
  `cloudflare-tanstack-website${BRANCH_PREFIX}`,
  {
    bindings: {
      BUCKET: bucket,
    },
  }
);

console.log({
  url: website.url,
});

await app.finalize();
