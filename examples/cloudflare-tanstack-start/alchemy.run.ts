import "../../alchemy/src/cloudflare";

import alchemy from "../../alchemy/src/";
import { TanStackStart } from "../../alchemy/src/cloudflare";

const app = await alchemy("tanstack-app");

const website = await TanStackStart("tanstack-website", {
  assets: ".output/public",
  main: "./src/index.ts",
});

console.log({
  url: website.url,
});

await app.finalize();
