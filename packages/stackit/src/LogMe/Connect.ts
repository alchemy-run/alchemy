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
  /** User name. */
  username: string;
  /** The user's password. */
  password: Redacted.Redacted<string>;
  /** Connection URI as STACKIT hands it out. `Redacted` because it embeds the password. */
  url: Redacted.Redacted<string>;
  /** Where to send syslog, when the API reports it. `Redacted`: it can embed a user. */
  syslogDrainUrl: Redacted.Redacted<string> | undefined;
}

/**
 * Runtime binding that resolves the connection settings of a {@link Credential} for
 * your own OpenSearch or syslog client. No connection is opened. To search logs without
 * a client, use `SearchLogs` instead.
 *
 * Binding it passes the host, port, user and password into the host's environment, with
 * the password and URLs kept `Redacted`. It grants no STACKIT role, since LogMe
 * authenticates with the user, and creates no service account. Provide
 * {@link ConnectHttp}.
 *
 * The host's egress IP has to be in the instance's `acl`, or it can't connect.
 *
 * ### Connecting with a Client
 * **Example:** Resolve the host from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.LogMe.Instance("Logs", {
 *   version: "2",
 *   planName: "stackit-logme2-1.2.50-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const App = Logs.pipe(
 *   Effect.flatMap((logs) => Stackit.LogMe.Credential("App", { instanceId: logs.instanceId })),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const connect = yield* Stackit.LogMe.Connect(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const info = yield* connect;
 *         return yield* HttpServerResponse.json({ host: info.host });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LogMe.ConnectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category LogMe
 */
export interface Connect extends Binding.Service<
  Connect,
  "Stackit.LogMe.Connect",
  (credential: Credential) => Effect.Effect<Effect.Effect<ConnectionInfo, never, RuntimeContext>>
> {}

export const Connect = Binding.Service<Connect>("Stackit.LogMe.Connect");
