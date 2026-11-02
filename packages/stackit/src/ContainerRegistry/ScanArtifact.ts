import type * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { RobotAccount } from "./RobotAccount.ts";

export interface ScanArtifactRequest extends Omit<harbor.ScanArtifactRequest, "project_name"> {}

/**
 * Runtime binding for the registry's `scanArtifact`: start a vulnerability or SBOM scan of an artifact; it runs in the background.
 *
 * Bind this operation to a {@link RobotAccount} in a Function/Worker init phase
 * and provide {@link ScanArtifactHttp}. The robot's project is injected into each
 * request. It works on any host: the robot's login is bound into the host's env.
 *
 * Access: the robot needs `{ resource: "scan", action: "create" }` in its
 * `permissions`. This binding grants nothing, because the registry's own API takes
 * a robot's login rather than a STACKIT role, and a robot's permissions cover its
 * whole registry project.
 *
 * ### Scanning an Artifact
 * **Example:** Start a scan from a Cloudflare Worker
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
 *     permissions: [{ resource: "scan", action: "create" }],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const robot = yield* Robot;
 *     const scanArtifact = yield* Stackit.ContainerRegistry.ScanArtifact(robot);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* scanArtifact({ repository_name: "app", reference: "1.0.0" });
 *         return HttpServerResponse.text("started");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.ScanArtifactHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface ScanArtifact extends Binding.Service<
  ScanArtifact,
  "Stackit.ContainerRegistry.ScanArtifact",
  (
    robot: RobotAccount,
  ) => Effect.Effect<
    (
      request: ScanArtifactRequest,
    ) => Effect.Effect<harbor.ScanArtifactResponse, harbor.ScanArtifactError, RuntimeContext>
  >
> {}

export const ScanArtifact = Binding.Service<ScanArtifact>("Stackit.ContainerRegistry.ScanArtifact");
