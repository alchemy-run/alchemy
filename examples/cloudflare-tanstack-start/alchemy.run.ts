import "../../alchemy/src/cloudflare";

import alchemy from "../../alchemy/src";
import { R2Bucket, TanStackStart } from "../../alchemy/src/cloudflare";

const app = await alchemy("tanstack-app");

const bucket = await R2Bucket("tanstack-bucket", {
  name: "tanstack-bucket",
});

export const website = await TanStackStart("tanstack-website", {
  bindings: {
    BUCKET: bucket,
  },
});

console.log({
  url: website.url,
});

await app.finalize();
