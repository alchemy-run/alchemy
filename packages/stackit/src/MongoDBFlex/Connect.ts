import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { User } from "./User.ts";

export interface ConnectionInfo {
  /** Host STACKIT reports for the user. */
  host: string | undefined;
  /** Port STACKIT reports for the user. */
  port: number | undefined;
  /** Database the user belongs to. */
  database: string | undefined;
  /** User name. */
  username: string;
  /** The user's password. */
  password: Redacted.Redacted<string>;
  /**
   * The connection string STACKIT returned for the user. Feed it to the `mongodb` driver.
   * `Redacted` because it embeds the password.
   */
  uri: Redacted.Redacted<string>;
}

/**
 * The bound user has no password or connection string on record: STACKIT only returns
 * them when it creates or resets a user, so an adopted user has neither. Set `rotationKey`
 * on the user.
 */
export class PasswordMissing extends Data.TaggedError("Stackit.MongoDBFlex.PasswordMissing")<{
  readonly userName: string;
  readonly message: string;
}> {}

/**
 * Runtime binding that resolves connection settings for a {@link User}. No socket is
 * opened: MongoDB speaks its wire protocol, not HTTP, so feed the result to your driver.
 *
 * Binding it passes the host, port, names, password and connection string into the host's
 * environment, with the secrets kept `Redacted`. It grants no STACKIT role, since MongoDB
 * connections authenticate with the database user, and creates no service account. Provide
 * {@link ConnectHttp}.
 *
 * The host's egress IP has to be in the instance's `acl`, or connections time out.
 *
 * ### Connecting with a Driver
 * **Example:** Resolve the URI from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.MongoDBFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 3,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 10 },
 *   acl: ["203.0.113.7/32"],
 *   backupSchedule: "0 2 * * *",
 * });
 * export const AppUser = Db.pipe(
 *   Effect.flatMap((db) =>
 *     Stackit.MongoDBFlex.User("AppUser", {
 *       instanceId: db.instanceId,
 *       database: "app",
 *       roles: ["readWrite"],
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const user = yield* AppUser;
 *     const connect = yield* Stackit.MongoDBFlex.Connect(user);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const info = yield* connect;
 *         return yield* HttpServerResponse.json({ database: info.database });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MongoDBFlex.ConnectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MongoDBFlex
 */
export interface Connect extends Binding.Service<
  Connect,
  "Stackit.MongoDBFlex.Connect",
  (user: User) => Effect.Effect<Effect.Effect<ConnectionInfo, PasswordMissing, RuntimeContext>>
> {}

export const Connect = Binding.Service<Connect>("Stackit.MongoDBFlex.Connect");
