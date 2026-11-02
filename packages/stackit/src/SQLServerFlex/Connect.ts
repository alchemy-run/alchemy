import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Database } from "./Database.ts";
import type { User } from "./User.ts";

export interface ConnectionInfo {
  /** Host of the instance. */
  host: string;
  /** Port of the instance. */
  port: number;
  /** Database name. */
  database: string;
  /** User name. */
  username: string;
  /** The user's password. */
  password: Redacted.Redacted<string>;
  /**
   * ADO-style connection string with `Encrypt=true`, for your driver. `Redacted`
   * because it embeds the password.
   */
  connectionString: Redacted.Redacted<string>;
  /** Always `true`: connect over TLS. */
  encrypt: true;
}

/**
 * The bound user has no password on record: STACKIT only returns one when it creates
 * or resets it, so an adopted user has none. Set `rotationKey` on the user.
 */
export class PasswordMissing extends Data.TaggedError("Stackit.SQLServerFlex.PasswordMissing")<{
  readonly userName: string;
  readonly message: string;
}> {}

/**
 * Runtime binding that resolves connection settings for a {@link Database} as a
 * {@link User}. No socket is opened: feed the result to your driver, which speaks SQL
 * Server's TDS protocol. STACKIT has no data API for SQL Server Flex.
 *
 * Binding it passes the host, port, names and password into the host's environment,
 * with the password kept `Redacted`. It grants no STACKIT role, since SQL Server
 * connections authenticate with the database user, and creates no service account.
 * Provide {@link ConnectHttp}.
 *
 * The host's egress IP has to be in the instance's `acl`, or connections time out.
 *
 * ### Connecting with a Driver
 * **Example:** Resolve the settings from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * export const AppUser = Db.pipe(
 *   Effect.flatMap((db) =>
 *     Stackit.SQLServerFlex.User("AppUser", {
 *       instanceId: db.instanceId,
 *       roles: ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"],
 *     }),
 *   ),
 * );
 * export const AppDatabase = Effect.gen(function* () {
 *   const db = yield* Db;
 *   const user = yield* AppUser;
 *   return yield* Stackit.SQLServerFlex.Database("AppDatabase", {
 *     instanceId: db.instanceId,
 *     owner: user.userName,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const database = yield* AppDatabase;
 *     const user = yield* AppUser;
 *     const connect = yield* Stackit.SQLServerFlex.Connect(database, user);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const info = yield* connect;
 *         return yield* HttpServerResponse.json({ database: info.database });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SQLServerFlex.ConnectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SQLServerFlex
 */
export interface Connect extends Binding.Service<
  Connect,
  "Stackit.SQLServerFlex.Connect",
  (
    database: Database,
    user: User,
  ) => Effect.Effect<Effect.Effect<ConnectionInfo, PasswordMissing, RuntimeContext>>
> {}

export const Connect = Binding.Service<Connect>("Stackit.SQLServerFlex.Connect");
