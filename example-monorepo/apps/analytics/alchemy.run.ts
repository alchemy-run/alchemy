import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";
import path from "node:path";

const app = await alchemy("analytics");

export const analytics = await Worker("worker", {
  entrypoint: path.join(import.meta.dirname, "src", "index.ts"),
  bindings: {
    API_KEY: alchemy.secret.env.API_KEY,
  },
});

if (import.meta.main) {
  console.log({ url: analytics.url });
}

await app.finalize();
