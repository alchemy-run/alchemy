import alchemy from "alchemy";
import { Orange } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-orange");

export const website = await Orange("website", {
  name: `${app.name}-${app.stage}-website`,
  dev: {
    command: "vite dev --port 5003",
  },
});

console.log({
  url: website.url,
});

await app.finalize();
