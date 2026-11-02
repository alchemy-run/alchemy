import type * as loki from "@distilled.cloud/stackit/logs_loki";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AccessToken } from "./AccessToken.ts";

export interface ReadInstanceClient {
  /** Run a metric LogQL query at one point in time. A log query fails with `BadRequest`. */
  query: (
    request: loki.QueryRequest,
  ) => Effect.Effect<loki.QueryResponse, loki.QueryError, RuntimeContext>;
  /** Run a LogQL query over a time range: log lines, or a matrix for a metric query. */
  queryRange: (
    request: loki.QueryRangeRequest,
  ) => Effect.Effect<loki.QueryRangeResponse, loki.QueryRangeError, RuntimeContext>;
}

/**
 * Bind an {@link AccessToken} to the read half of a Logs instance's Loki API: `query`
 * and `queryRange`. Provide {@link ReadInstanceHttp}.
 *
 * Calls authenticate with the token, on the instance's own Grafana Loki API, so this
 * grants no STACKIT role and creates no service account: the token and the instance's
 * URL travel through the host's environment, with the token kept `Redacted`. The token
 * needs the `read` permission, or Loki's gateway refuses the call. The host's egress
 * IP has to be in the instance's `acl`, or it can't connect.
 *
 * ### Querying Logs
 * **Example:** Read recent log lines from a Cloudflare Worker
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
 *       permissions: ["read"],
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const logs = yield* Stackit.Logs.ReadInstance(yield* Token);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const found = yield* logs.queryRange({ query: '{app="api"}', since: "5m", limit: 100 });
 *         return yield* HttpServerResponse.json({ streams: found.data.result.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.ReadInstanceHttp)),
 * ) {}
 * ```
 *
 * **Example:** Run a metric query from a Cloudflare Worker
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
 *       permissions: ["read"],
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const logs = yield* Stackit.Logs.ReadInstance(yield* Token);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const found = yield* logs.query({ query: 'sum(rate({app="api"}[5m]))' });
 *         return yield* HttpServerResponse.json({ result: found.data.result });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.ReadInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface ReadInstance extends Binding.Service<
  ReadInstance,
  "Stackit.Logs.ReadInstance",
  (accessToken: AccessToken) => Effect.Effect<ReadInstanceClient>
> {}

export const ReadInstance = Binding.Service<ReadInstance>("Stackit.Logs.ReadInstance");
