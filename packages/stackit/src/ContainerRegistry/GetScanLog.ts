import type * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { RobotAccount } from "./RobotAccount.ts";

export interface GetScanLogRequest extends Omit<harbor.GetReportLogRequest, "project_name"> {}

/**
 * Runtime binding for the registry's `getReportLog`: read the log of one scan, by the `report_id` in the artifact's scan overview.
 *
 * Bind this operation to a {@link RobotAccount} in a Function/Worker init phase
 * and provide {@link GetScanLogHttp}. The robot's project is injected into each
 * request. It works on any host: the robot's login is bound into the host's env.
 *
 * Access: the robot needs `{ resource: "scan", action: "read" }` in its
 * `permissions`. This binding grants nothing, because the registry's own API takes
 * a robot's login rather than a STACKIT role, and a robot's permissions cover its
 * whole registry project.
 *
 * ### Reading a Scan Log
 * **Example:** Read a scan log from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Images = Stackit.ContainerRegistry.Project("Images", {});
 * export const Robot = Effect.gen(function* () {
 *   const images = yield* Images;
 *   return yield* Stackit.ContainerRegistry.RobotAccount("Robot", {
 *     project: images.name,
 *     registryUrl: images.url,
 *     credentials: {
 *       username: Config.String("HARBOR_USERNAME"),
 *       secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *     },
 *     permissions: [{ resource: "scan", action: "read" }],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const robot = yield* Robot;
 *     const getScanLog = yield* Stackit.ContainerRegistry.GetScanLog(robot);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const log = yield* getScanLog({
 *           repository_name: "app",
 *           reference: "1.0.0",
 *           report_id: "00000000-0000-0000-0000-000000000000",
 *         });
 *         return HttpServerResponse.text(log);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.GetScanLogHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface GetScanLog extends Binding.Service<
  GetScanLog,
  "Stackit.ContainerRegistry.GetScanLog",
  (
    robot: RobotAccount,
  ) => Effect.Effect<
    (
      request: GetScanLogRequest,
    ) => Effect.Effect<harbor.GetReportLogResponse, harbor.GetReportLogError, RuntimeContext>
  >
> {}

export const GetScanLog = Binding.Service<GetScanLog>("Stackit.ContainerRegistry.GetScanLog");
