import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";
import path from "node:path";

const app = await alchemy("backend");

// const db = await D1Database("db");

export const backend = await Worker("worker", {
  entrypoint: path.join(import.meta.dirname, "src", "index.ts"),
  bindings: {
    // db,
    API_KEY: alchemy.secret.env.API_KEY,
  },
});

if (import.meta.main) {
  console.log({ url: backend.url });
}

await app.finalize();
