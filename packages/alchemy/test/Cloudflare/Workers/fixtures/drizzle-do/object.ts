import * as Cloudflare from "@/Cloudflare";
import * as Drizzle from "@/Drizzle";
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
    return Effect.gen(function* () {
      // Opens drizzle over this instance's SQLite storage and applies the
      // generated migrations before any request touches the db.
      const db = yield* Drizzle.DurableObject({ migrations });

      return {
        addUser: (name: string) =>
          Effect.sync(() => db.insert(users).values({ name }).run()).pipe(
            Effect.asVoid,
          ),
        listUsers: () =>
          Effect.sync(() =>
            db
              .select()
              .from(users)
              .all()
              .map((row) => row.name),
          ),
      };
    });
  }),
) {}
