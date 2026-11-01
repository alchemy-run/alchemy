import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { AccessToken } from "./AccessToken.ts";
import type { ReadInstanceClient } from "./ReadInstance.ts";
import type { WriteInstanceClient } from "./WriteInstance.ts";

export interface ReadWriteInstanceClient extends ReadInstanceClient, WriteInstanceClient {}

/**
 * Bind an {@link AccessToken} to all of a Logs instance's Loki API: `query`,
 * `queryRange`, `push` and `pushOtlp`. Provide {@link ReadWriteInstanceHttp}.
 *
 * Calls authenticate with the token, on the instance's own Grafana Loki API, so this
 * grants no STACKIT role and creates no service account: the token and the instance's
 * URL travel through the host's environment, with the token kept `Redacted`. The token
 * needs both the `read` and `write` permissions, or Loki's gateway refuses the call it
 * lacks. The host's egress IP has to be in the instance's `acl`, or it can't connect.
 *
 * ### Pushing and Querying Logs
 * **Example:** Push a line and query it back from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.Logs.Instance("Logs", { acl: ["0.0.0.0/0"] });
 * export const Token = Logs.pipe(
 *   Effect.flatMap((logs) =>
 *     Stackit.Logs.AccessToken("Token", {
 *       instanceId: logs.instanceId,
 *       permissions: ["read", "write"],
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const logs = yield* Stackit.Logs.ReadWriteInstance(yield* Token);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* logs.push({
 *           streams: [{ stream: { app: "api" }, values: [[`${Date.now()}000000`, "hello"]] }],
 *         });
 *         const found = yield* logs.queryRange({ query: '{app="api"}', since: "5m" });
 *         return yield* HttpServerResponse.json({ streams: found.data.result.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.ReadWriteInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface ReadWriteInstance extends Binding.Service<
  ReadWriteInstance,
  "Stackit.Logs.ReadWriteInstance",
  (accessToken: AccessToken) => Effect.Effect<ReadWriteInstanceClient>
> {}

export const ReadWriteInstance = Binding.Service<ReadWriteInstance>(
  "Stackit.Logs.ReadWriteInstance",
);
