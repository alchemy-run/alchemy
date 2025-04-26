import alchemy from "../../alchemy/src/";
import { D1Database, Redwood } from "../../alchemy/src/cloudflare";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "";

const app = await alchemy("cloudflare-redwood", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

const database = await D1Database(`cloudflare-redwood-db${BRANCH_PREFIX}`, {
  migrationsDir: "drizzle",
});

export const website = await Redwood(
  `cloudflare-redwood-website${BRANCH_PREFIX}`,
  {
    bindings: {
      DB: database,
    },
  },
);

console.log({
  url: website.url,
});

await app.finalize();
