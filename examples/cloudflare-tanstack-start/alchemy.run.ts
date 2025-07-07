import alchemy from "alchemy";
import { TanStackStart } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-tanstack");

export const website = await TanStackStart("website", {
  name: `${app.name}-${app.stage}-website`,
});

console.log({
  url: website.url,
});

await app.finalize();
