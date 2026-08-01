import * as Cloudflare from "@/Cloudflare";
import * as Drizzle from "@/Drizzle";
import * as Effect from "effect/Effect";
// The exact artifacts `drizzle-kit generate` emits for
// `driver: "durable-sqlite"` — a `migrations.js` that imports each
// migration's `.sql` file as a text module. Bare `.sql` imports resolve
// via the bundler's default text module types (see Bundle.ts), the same
// way Wrangler's `Text` rules handle them.
import migrations from "./drizzle/migrations.js";
import { posts, relations, users } from "./schema.ts";

export class DrizzleUsersObject extends Cloudflare.DurableObject<DrizzleUsersObject>()(
  "DrizzleUsersObject",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      // Opens drizzle over this instance's SQLite storage — with the
      // relational schema — and applies the generated migrations before
      // any request touches the db.
      const db = yield* Drizzle.DurableObject({ migrations, relations });

      return {
        addUser: (name: string) =>
          Effect.sync(
            () => db.insert(users).values({ name }).returning().get().id,
          ),
        addPost: (userId: number, title: string) =>
          Effect.sync(() =>
            db.insert(posts).values({ userId, title }).run(),
          ).pipe(Effect.asVoid),
        listUsers: () =>
          Effect.sync(() =>
            db
              .select()
              .from(users)
              .all()
              .map((row) => row.name),
          ),
        // Relational query through the `relations` config — proves the
        // schema/relationships flow through Drizzle.DurableObject's types.
        listUsersWithPosts: () =>
          Effect.promise(() =>
            db.query.users.findMany({ with: { posts: true } }),
          ).pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                name: row.name,
                posts: row.posts.map((post) => post.title),
              })),
            ),
          ),
      };
    });
  }),
) {}
