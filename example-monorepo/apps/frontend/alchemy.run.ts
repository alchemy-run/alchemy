import alchemy from "alchemy";
import { Vite } from "alchemy/cloudflare";
import { analytics } from "analytics/alchemy";
import { backend } from "backend/alchemy";

const app = await alchemy("frontend");

export const frontend = await Vite("website", {
  bindings: {
    backend,
    analytics,
  },
});

console.log({
  url: frontend.url,
});

await app.finalize();
