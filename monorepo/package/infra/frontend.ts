import alchemy from "alchemy";
import { Vite } from "alchemy/cloudflare";
import { backend } from "./backend";

const app = await alchemy("frontend");

export const frontend = await Vite("website", {
  bindings: {
    backend,
  },
});

console.log({
  url: frontend.url,
});

await app.finalize();
