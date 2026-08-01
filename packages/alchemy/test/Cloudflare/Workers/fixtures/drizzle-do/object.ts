import * as Cloudflare from "@/Cloudflare";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import * as Effect from "effect/Effect";
// The exact artifacts `drizzle-kit generate` emits for
// `driver: "durable-sqlite"` — a `migrations.js` that imports each
// migration's `.sql` file as a text module. Bare `.sql` imports resolve
// via the bundler's default text module types (see Bundle.ts), the same
// way Wrangler's `Text` rules handle them.
import migrations from "./drizzle/migrations.js";
import { users } from "./schema.ts";

export class DrizzleUsersObject extends Cloudflare.DurableObject<DrizzleUsersObject>()(
  "DrizzleUsersObject",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const db = yield* Effect.sync(() => drizzle(state.raw.storage));
    // The durable-sqlite driver and migrator are synchronous — run the
    // migrations once at instance init, before any request touches the db.
    // Guarded: the constructor also runs at plan time (binding discovery)
    // with a mock DurableObjectState that has no real storage.
    if (globalThis.__ALCHEMY_RUNTIME__) {
      yield* Effect.sync(() => migrate(db, migrations));
    }

    return Effect.gen(function* () {
      return {
        addUser: (name: string) =>
          Effect.sync(() => db.insert(users).values({ name }).run()).pipe(
            Effect.asVoid,
          ),
        listUsers: () =>
          Effect.sync(() => db.select().from(users).all()).pipe(
            Effect.map((rows) => rows.map((row) => row.name)),
          ),
      };
    });
  }),
) {}
