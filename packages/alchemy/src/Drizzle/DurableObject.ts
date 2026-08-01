import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import type { DrizzleSQLiteConfig } from "drizzle-orm/sqlite-core/utils";
import * as Effect from "effect/Effect";
import { DurableObjectState } from "../Cloudflare/Workers/DurableObjectState.ts";

export interface DurableObjectConfig<
  TRelations extends AnyRelations = EmptyRelations,
> extends Omit<DrizzleSQLiteConfig<TRelations>, "jit"> {
  /**
   * Migrations to apply before the db is returned — pass the default
   * export of drizzle-kit's generated `migrations.js` directly.
   */
  readonly migrations?:
    | { readonly migrations: Record<string, string> }
    | undefined;
}

/**
 * Open a Drizzle database over the current Durable Object's SQLite
 * storage (`drizzle-orm/durable-sqlite`), applying drizzle-kit's
 * generated migrations first when provided. The driver and migrator are
 * synchronous, so yield it in the object's inner (instance) Effect —
 * it runs when the instance activates, before any request reaches its
 * methods.
 *
 * The config passes the driver's options through: `relations` (from
 * `defineRelations`) enables typed relational queries via `db.query`.
 *
 * ```typescript
 * // schema.ts
 * import { defineRelations } from "drizzle-orm";
 * import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
 *
 * export const users = sqliteTable("users", {
 *   id: integer("id").primaryKey({ autoIncrement: true }),
 *   name: text("name").notNull(),
 * });
 *
 * export const posts = sqliteTable("posts", {
 *   id: integer("id").primaryKey({ autoIncrement: true }),
 *   userId: integer("user_id").notNull().references(() => users.id),
 *   title: text("title").notNull(),
 * });
 *
 * export const relations = defineRelations({ users, posts }, (t) => ({
 *   users: { posts: t.many.posts() },
 *   posts: { author: t.one.users({ from: t.posts.userId, to: t.users.id }) },
 * }));
 * ```
 *
 * ```typescript
 * import migrations from "./drizzle/migrations.js";
 * import { posts, relations, users } from "./schema.ts";
 *
 * export class Users extends Cloudflare.DurableObject<Users>()(
 *   "Users",
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const db = yield* Drizzle.DurableObject({ migrations, relations });
 *
 *       return {
 *         addUser: (name: string) =>
 *           Effect.sync(() => db.insert(users).values({ name }).run()),
 *         listUsers: () => Effect.sync(() => db.select().from(users).all()),
 *         listUsersWithPosts: () =>
 *           Effect.promise(() =>
 *             db.query.users.findMany({ with: { posts: true } }),
 *           ),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @binding
 */
export const DurableObject = <TRelations extends AnyRelations = EmptyRelations>(
  config?: DurableObjectConfig<TRelations>,
) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const { migrations, ...drizzleConfig } = config ?? {};
    return yield* Effect.sync(() => {
      const db = drizzle<TRelations>(state.raw.storage, drizzleConfig);
      if (migrations !== undefined) {
        migrate(db, migrations);
      }
      return db;
    });
  });
