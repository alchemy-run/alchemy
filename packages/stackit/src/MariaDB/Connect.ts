import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Credential } from "./Credential.ts";

export interface ConnectionInfo {
  /** Host of the instance. */
  host: string;
  /** Port of the instance, when the API reports one. */
  port: number | undefined;
  /** Name of the instance's database, when the API reports one. */
  database: string | undefined;
  /** User name. */
  username: string;
  /** The user's password. */
  password: Redacted.Redacted<string>;
  /**
   * Connection URI as STACKIT hands it out. Feed it to `Drizzle.MySQL` or `mysql2`.
   * `Redacted` because it embeds the password.
   */
  url: Redacted.Redacted<string>;
}

/**
 * Runtime binding that resolves the connection settings of a {@link Credential}. No
 * socket is opened: feed the result to your driver.
 *
 * Binding it passes the host, port, names and password into the host's environment,
 * with the password and URI kept `Redacted`. It grants no STACKIT role, since MariaDB
 * connections authenticate with the database user, and creates no service account.
 * Provide {@link ConnectHttp}.
 *
 * The host's egress IP has to be in the instance's `acl`, or it can't connect.
 *
 * ### Connecting with a Driver
 * **Example:** Resolve the URI from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.MariaDB.Instance("Db", {
 *   version: "10.11",
 *   planName: "stackit-mariadb-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const App = Db.pipe(
 *   Effect.flatMap((db) => Stackit.MariaDB.Credential("App", { instanceId: db.instanceId })),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const connect = yield* Stackit.MariaDB.Connect(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const info = yield* connect;
 *         return yield* HttpServerResponse.json({ host: info.host });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MariaDB.ConnectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MariaDB
 */
export interface Connect extends Binding.Service<
  Connect,
  "Stackit.MariaDB.Connect",
  (credential: Credential) => Effect.Effect<Effect.Effect<ConnectionInfo, never, RuntimeContext>>
> {}

export const Connect = Binding.Service<Connect>("Stackit.MariaDB.Connect");
