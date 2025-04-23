import "alchemy/cloudflare";

import alchemy from "alchemy";
import { D1Database, Redwood } from "alchemy/cloudflare";

const app = await alchemy("redwood-app");

const database = await D1Database("redwood-db", {
  name: "redwood-db",
  migrationsDir: "drizzle",
});

export const website = await Redwood("redwood-website", {
  bindings: {
    DB: database,
  },
});

console.log({
  url: website.url,
});

await app.finalize();
