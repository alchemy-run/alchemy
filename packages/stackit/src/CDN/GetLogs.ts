import type * as cdn from "@distilled.cloud/stackit/cdn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Distribution } from "./Distribution.ts";

export interface GetLogsRequest extends Omit<cdn.GetLogsRequest, "projectId" | "distributionId"> {}

/**
 * Runtime binding for CDN `GetLogs`: read a distribution's access logs.
 *
 * Bind this operation to a {@link Distribution} in a Function/Worker init phase and provide
 * {@link GetLogsHttp}. The resource's project and id are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `cdn.distribution.get` on the project holding
 * the distribution, so it reaches every distribution in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single
 * distribution. The deployer needs `iam.role.add` on that scope to define the
 * role.
 *
 * ### Reading Logs
 * **Example:** Read cache misses from a Cloudflare Worker
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
 *     const getLogs = yield* Stackit.CDN.GetLogs(yield* Cdn);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { logs } = yield* getLogs({ cacheHit: false, pageSize: 100 });
 *         return yield* HttpServerResponse.json({ paths: logs.map((entry) => entry.path) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CDN.GetLogsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT CDN
 * @category CDN
 */
export interface GetLogs extends Binding.Service<
  GetLogs,
  "Stackit.CDN.GetLogs",
  (
    distribution: Distribution,
  ) => Effect.Effect<
    (
      request?: GetLogsRequest,
    ) => Effect.Effect<cdn.GetLogsResponse, cdn.GetLogsError, RuntimeContext>
  >
> {}

export const GetLogs = Binding.Service<GetLogs>("Stackit.CDN.GetLogs");
