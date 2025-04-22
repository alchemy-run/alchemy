import "alchemy/cloudflare";

import alchemy from "alchemy/";
import { TanStackStart } from "alchemy/cloudflare";

const app = await alchemy("tanstack-app");

const website = await TanStackStart("tanstack-website");

console.log({
  url: website.url,
});

await app.finalize();
