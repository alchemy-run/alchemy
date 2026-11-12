import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { HttpClientError } from "effect/http/HttpClientError";
import type { RunQueryApiEndpointFailed } from "../Errors.ts";
import type { QueryApiEndpoint } from "./QueryApiEndpoint.ts";

/** One run of a Query API endpoint. */
export interface RunQueryApiEndpointRequest {
  /** Values of the SQL's `{name:Type}` placeholders; the endpoint's defaults fill the rest. */
  queryVariables?: Record<string, unknown>;
}

/**
 * Run a Query API endpoint at runtime and get its rows as JSON objects.
 *
 * Binding gives the host its own API key, with a role that allows only
 * `control-plane:service:view-query-api-endpoints` on the endpoint's
 * service (a key can't exist without a role), and adds that key to the
 * endpoint's `apiKeyIds`, so this host and the keys you list are the only
 * callers. ClickHouse Cloud federates no workload identity, so a key is the
 * only way in. The call goes to the endpoint's `url` as ClickHouse hands it
 * back.
 *
 * ### Running an Endpoint
 * **Example:** Serve a report from a Worker
 * ```typescript
 * export const TopPages = ClickHouseCloud.QueryApiEndpoints.QueryApiEndpoint("TopPages", {
 *   serviceId: analytics.serviceId,
 *   database: "default",
 *   sql: "SELECT path, count() AS hits FROM events WHERE day = {day:Date} GROUP BY path ORDER BY hits DESC LIMIT 10",
 *   roles: ["default_role"],
 * });
 *
 * export default class Reports extends Cloudflare.Worker<Reports>()(
 *   "Reports",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: creates the host's key and allows it on the endpoint
 *     const topPages = yield* ClickHouseCloud.QueryApiEndpoints.RunQueryApiEndpoint(TopPages);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const rows = yield* topPages({ queryVariables: { day: "2026-11-01" } });
 *         return yield* HttpServerResponse.json(rows);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.QueryApiEndpoints.RunQueryApiEndpointHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Query API Endpoint
 */
export interface RunQueryApiEndpoint extends Binding.Service<
  RunQueryApiEndpoint,
  "ClickHouseCloud.QueryApiEndpoints.RunQueryApiEndpoint",
  (
    target: QueryApiEndpoint,
  ) => Effect.Effect<
    (
      request?: RunQueryApiEndpointRequest,
    ) => Effect.Effect<
      Array<Record<string, unknown>>,
      RunQueryApiEndpointFailed | HttpClientError,
      RuntimeContext
    >
  >
> {}

export const RunQueryApiEndpoint = Binding.Service<RunQueryApiEndpoint>(
  "ClickHouseCloud.QueryApiEndpoints.RunQueryApiEndpoint",
);
