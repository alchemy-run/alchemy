import type * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { RobotAccount } from "./RobotAccount.ts";

export interface GetScanReportRequest extends Omit<
  harbor.GetVulnerabilitiesAdditionRequest,
  "project_name"
> {}

/**
 * Runtime binding for the registry's `getVulnerabilitiesAddition`: read an artifact's vulnerability report, a JSON document keyed by report MIME type.
 *
 * Bind this operation to a {@link RobotAccount} in a Function/Worker init phase
 * and provide {@link GetScanReportHttp}. The robot's project is injected into each
 * request. It works on any host: the robot's login is bound into the host's env.
 *
 * Access: the robot needs `{ resource: "artifact-addition", action: "read" }` in its
 * `permissions`. This binding grants nothing, because the registry's own API takes
 * a robot's login rather than a STACKIT role, and a robot's permissions cover its
 * whole registry project.
 *
 * ### Reading a Scan Report
 * **Example:** Read a scan report from a Cloudflare Worker
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
 *     permissions: [{ resource: "artifact-addition", action: "read" }],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const robot = yield* Robot;
 *     const getScanReport = yield* Stackit.ContainerRegistry.GetScanReport(robot);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const report = yield* getScanReport({ repository_name: "app", reference: "1.0.0" });
 *         return yield* HttpServerResponse.json({ report });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.GetScanReportHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface GetScanReport extends Binding.Service<
  GetScanReport,
  "Stackit.ContainerRegistry.GetScanReport",
  (
    robot: RobotAccount,
  ) => Effect.Effect<
    (
      request: GetScanReportRequest,
    ) => Effect.Effect<
      harbor.GetVulnerabilitiesAdditionResponse,
      harbor.GetVulnerabilitiesAdditionError,
      RuntimeContext
    >
  >
> {}

export const GetScanReport = Binding.Service<GetScanReport>(
  "Stackit.ContainerRegistry.GetScanReport",
);
