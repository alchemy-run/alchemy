import type { ConfigError } from "@distilled.cloud/core/errors";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { User } from "./User.ts";

export interface ConnectionInfo {
  /** The URL of the instance's console, where Dremio's REST API is called. */
  uiUrl: string;
  /** The instance's catalog endpoint. */
  catalogUrl: string;
  /** The instance's Arrow Flight endpoint. */
  arrowFlightUrl: string;
  /** Login name of the user. */
  username: string;
  /** The user's password. */
  password: Redacted.Redacted<string>;
  /** A token from Dremio's login, cached until shortly before it expires. */
  token: Redacted.Redacted<string>;
}

/**
 * Runtime binding that resolves a {@link User}'s endpoints and login for your own Dremio client,
 * such as an Arrow Flight driver. It opens no connection. To run SQL without a client, use
 * `ExecuteSql` instead.
 *
 * Binding it passes the endpoints, user name and password into the host's environment, with the
 * password kept `Redacted`. Getting `token` logs in to Dremio's REST API at `uiUrl`, so a failed
 * login fails the call with `ConfigError`. It grants no STACKIT role and creates no service
 * account, since Dremio authenticates the user itself. Provide {@link ConnectHttp}.
 *
 * A `Stackit.Dremio.User` is an admin of its instance. The host's egress IP has to be in the
 * instance's `acl`, unless that list is empty.
 *
 * ### Connecting with a Client
 * **Example:** Resolve the endpoints from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Alchemy from "alchemy";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Lakehouse = Stackit.Dremio.Instance("Lakehouse", {});
 * export const Analyst = Effect.gen(function* () {
 *   const lakehouse = yield* Lakehouse;
 *   const password = yield* Alchemy.Random("AnalystPassword");
 *   return yield* Stackit.Dremio.User("Analyst", {
 *     instanceId: lakehouse.instanceId,
 *     email: "analyst@example.com",
 *     firstName: "Ada",
 *     lastName: "Analyst",
 *     password: password.text,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const analyst = yield* Analyst;
 *     const connect = yield* Stackit.Dremio.Connect(analyst);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const info = yield* connect;
 *         return yield* HttpServerResponse.json({ flight: info.arrowFlightUrl });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Dremio.ConnectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Dremio
 */
export interface Connect extends Binding.Service<
  Connect,
  "Stackit.Dremio.Connect",
  (user: User) => Effect.Effect<Effect.Effect<ConnectionInfo, ConfigError, RuntimeContext>>
> {}

export const Connect = Binding.Service<Connect>("Stackit.Dremio.Connect");
