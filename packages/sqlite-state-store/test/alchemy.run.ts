import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";

const stores = ["d1", "bun-sqlite", "better-sqlite3", "libsql"] as const;

const store = async (type: string | undefined) => {
  switch (type) {
    case "d1": {
      const { D1StateStore } = await import(
        "@alchemy.run/sqlite-state-store/d1"
      );
      return D1StateStore;
    }
    case "bun-sqlite": {
      const { BunSQLiteStateStore } = await import(
        "@alchemy.run/sqlite-state-store/bun-sqlite"
      );
      return BunSQLiteStateStore;
    }
    case "better-sqlite3": {
      const { BetterSQLite3StateStore } = await import(
        "@alchemy.run/sqlite-state-store/better-sqlite3"
      );
      return BetterSQLite3StateStore;
    }
    case "libsql": {
      const { LibSQLStateStore } = await import(
        "@alchemy.run/sqlite-state-store/libsql"
      );
      return LibSQLStateStore;
    }
    default: {
      throw new Error(
        `Invalid store type: ${type} (valid types: ${stores.join(", ")})`
      );
    }
  }
};

const storeType = process.argv[2];
const StoreConstructor = await store(storeType);

console.log(`Using store: ${storeType}`);

const app = await alchemy("test", {
  stateStore: (scope) => new StoreConstructor(scope),
});

await Worker("my-worker-1", {
  name: `${app.appName}-${app.stage}-my-worker-1`,
  script: `
        export default {
            fetch(request, env, ctx) {
                return new Response("Hello, world!");
            }
        }
        `,
  adopt: true,
});

await alchemy.run("sub-scope", async () => {
  return await Worker("my-worker-2", {
    name: `${app.appName}-${app.stage}-my-worker-2`,
    script: `
          export default {
              fetch(request, env, ctx) {
                  return new Response("Hello, world!");
              }
          }
          `,
    adopt: true,
  });
});

await app.finalize();
