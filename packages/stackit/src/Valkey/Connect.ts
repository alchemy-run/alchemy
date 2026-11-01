import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Credential } from "./Credential.ts";

export interface ConnectionInfo {
  /** Host of the instance. */
  host: string;
  /** Every host of the instance. */
  hosts: string[];
  /** Host that balances across a replicated instance, when the API reports one. */
  loadBalancedHost: string | undefined;
  /** Port of the instance, when the API reports one. */
  port: number | undefined;
  /** User name. */
  username: string;
  /** The user's password. */
  password: Redacted.Redacted<string>;
  /** Connection URI as STACKIT hands it out. `Redacted` because it embeds the password. */
  url: Redacted.Redacted<string>;
}

/**
 * Runtime binding that resolves the connection settings of a {@link Credential} for
 * your own Redis or Valkey client. No socket is opened. To run commands, use
 * `ReadWriteValkey` instead.
 *
 * Binding it passes the host, port, user and password into the host's environment,
 * with the password and URI kept `Redacted`. It grants no STACKIT role, since Valkey
 * connections authenticate with the user, and creates no service account. Provide
 * {@link ConnectHttp}.
 *
 * The host's egress IP has to be in the instance's `acl`, or it can't connect.
 *
 * ### Connecting with a Client
 * **Example:** Resolve the URI from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Cache = Stackit.Valkey.Instance("Cache", {
 *   version: "x",
 *   planName: "stackit-keyvalue-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const App = Cache.pipe(
 *   Effect.flatMap((cache) => Stackit.Valkey.Credential("App", { instanceId: cache.instanceId })),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const connect = yield* Stackit.Valkey.Connect(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const info = yield* connect;
 *         return yield* HttpServerResponse.json({ host: info.host });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Valkey.ConnectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Valkey
 */
export interface Connect extends Binding.Service<
  Connect,
  "Stackit.Valkey.Connect",
  (credential: Credential) => Effect.Effect<Effect.Effect<ConnectionInfo, never, RuntimeContext>>
> {}

export const Connect = Binding.Service<Connect>("Stackit.Valkey.Connect");
