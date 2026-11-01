import type * as cdn from "@distilled.cloud/stackit/cdn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Distribution } from "./Distribution.ts";

export interface GetStatisticsRequest extends Omit<
  cdn.GetStatisticsRequest,
  "projectId" | "distributionId"
> {}

/**
 * Runtime binding for CDN `GetStatistics`: read a distribution's traffic and cache-hit statistics.
 *
 * Timestamps are taken as UTC, and a time interval with no statistics has no record.
 *
 * Bind this operation to a {@link Distribution} in a Function/Worker init phase and provide
 * {@link GetStatisticsHttp}. The resource's project and id are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `cdn.distribution.get` on the project holding
 * the distribution, so it reaches every distribution in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single
 * distribution. The deployer needs `iam.role.add` on that scope to define the
 * role.
 *
 * ### Reading Statistics
 * **Example:** Report daily traffic from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Cdn = Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getStatistics = yield* Stackit.CDN.GetStatistics(yield* Cdn);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { records } = yield* getStatistics({
 *           from: "2026-11-01T00:00:00Z",
 *           interval: "daily",
 *         });
 *         return yield* HttpServerResponse.json({
 *           bytes: records.map((record) => record.totalTrafficBytes),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CDN.GetStatisticsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT CDN
 * @category CDN
 */
export interface GetStatistics extends Binding.Service<
  GetStatistics,
  "Stackit.CDN.GetStatistics",
  (
    distribution: Distribution,
  ) => Effect.Effect<
    (
      request: GetStatisticsRequest,
    ) => Effect.Effect<cdn.GetStatisticsResponse, cdn.GetStatisticsError, RuntimeContext>
  >
> {}

export const GetStatistics = Binding.Service<GetStatistics>("Stackit.CDN.GetStatistics");
