import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Credential } from "./Credential.ts";

export interface ConnectionInfo {
  /** Host of the broker. */
  host: string;
  /** Hosts of the broker, one per node. */
  hosts: string[];
  /** AMQP port of the broker. */
  port: number | undefined;
  /** User name. */
  username: string;
  /** The user's password. */
  password: Redacted.Redacted<string>;
  /** AMQP URI to feed to a client. `Redacted` because it embeds the password. */
  uri: Redacted.Redacted<string>;
  /** AMQP URIs, one per node. `Redacted` because they embed the password. */
  uris: Redacted.Redacted<string>[];
  /** Address of the broker's management HTTP API. */
  httpApiUri: Redacted.Redacted<string> | undefined;
}

/**
 * Runtime binding that resolves connection settings for a {@link Credential}. No
 * socket is opened: feed the result to your AMQP client.
 *
 * Binding it passes the addresses, user and password into the host's environment, with
 * the secrets kept `Redacted`. It grants no STACKIT role, since broker connections
 * authenticate with the credential, and creates no service account. Provide
 * {@link ConnectHttp}.
 *
 * The host's egress IP has to be in the instance's `acl`, or connections time out.
 *
 * ### Connecting with a Client
 * **Example:** Resolve the URI from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Broker = Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["0.0.0.0/0"],
 * });
 * export const App = Broker.pipe(
 *   Effect.flatMap((broker) =>
 *     Stackit.RabbitMQ.Credential("App", { instanceId: broker.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const connect = yield* Stackit.RabbitMQ.Connect(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const info = yield* connect;
 *         return yield* HttpServerResponse.json({ host: info.host });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.ConnectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface Connect extends Binding.Service<
  Connect,
  "Stackit.RabbitMQ.Connect",
  (credential: Credential) => Effect.Effect<Effect.Effect<ConnectionInfo, never, RuntimeContext>>
> {}

export const Connect = Binding.Service<Connect>("Stackit.RabbitMQ.Connect");
