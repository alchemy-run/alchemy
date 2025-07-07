import alchemy from "alchemy";
import { Astro } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-astro");

export const website = await Astro("website", {
  name: `${app.name}-${app.stage}-website`,
  command: "bun run build",
});

console.log({
  url: website.url,
});

await app.finalize();
