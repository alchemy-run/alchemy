import "alchemy/cloudflare";

import alchemy from "../../alchemy/src";
import { D1Database, Redwood } from "../../alchemy/src/cloudflare";

const app = await alchemy("redwood-app");

const database = await D1Database("redwood-db", {
  name: "redwood-db",
  migrationsDir: "drizzle",
});

export const website = await Redwood("redwood-website", {
  command: "bun run clean && RWSDK_DEPLOY=1 bun run build",
  bindings: {
    DB: database,
  },
});

console.log({
  url: website.url,
});

await app.finalize();
