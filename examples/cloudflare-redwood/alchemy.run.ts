import alchemy from "alchemy";
import { D1Database, Redwood } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-redwood");

const database = await D1Database("database", {
  name: `${app.name}-${app.stage}-db`,
  migrationsDir: "drizzle",
  adopt: true,
});

export const website = await Redwood("website", {
  name: `${app.name}-${app.stage}-website`,
  adopt: true,
  bindings: {
    DB: database,
  },
  dev: {
    command: "vite dev --port 5004",
  },
});

console.log({
  url: website.url,
});

await app.finalize();
