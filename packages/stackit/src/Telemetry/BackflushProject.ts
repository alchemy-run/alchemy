import type * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Link } from "./Link.ts";

export interface BackflushProjectRequest extends Omit<
  telemetry.CreateProjectBackflushJobRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for Telemetry Link `createProjectBackflushJob`: start a backflush
 * job on the project's link, from a runtime or a script. STACKIT describes it only as
 * creating a backflush job; what it replays, and from when, is not documented. A job
 * has no delete or cancel.
 *
 * Bind this operation to a {@link Link} whose `scope` is a project in a
 * Function/Worker init phase and provide {@link BackflushProjectHttp}. The link's
 * project and region are injected into each request. Binding it to a link of another
 * scope fails the deploy. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding only `telemetry-link.instance.update`, on the project.
 * STACKIT binds roles on projects, folders and organizations, and a link has no finer
 * scope. The deployer needs `iam.role.add` on the project to define it.
 *
 * ### Starting a Backflush
 * **Example:** Start a job on the project's link from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Audit = Effect.gen(function* () {
 *   const router = yield* Stackit.Telemetry.Router("Audit", {});
 *   const token = yield* Stackit.Telemetry.AccessToken("AuditToken", {
 *     routerId: router.routerId,
 *   });
 *   return yield* Stackit.Telemetry.Link("AuditProject", {
 *     routerId: router.routerId,
 *     accessToken: token.accessToken,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const backflushProject = yield* Stackit.Telemetry.BackflushProject(yield* Audit);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* backflushProject({ displayName: "replay" });
 *         return yield* HttpServerResponse.json({ id: result.id, status: result.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.BackflushProjectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface BackflushProject extends Binding.Service<
  BackflushProject,
  "Stackit.Telemetry.BackflushProject",
  (
    link: Link,
  ) => Effect.Effect<
    (
      request?: BackflushProjectRequest,
    ) => Effect.Effect<
      telemetry.BackflushJobResponse,
      telemetry.CreateProjectBackflushJobError,
      RuntimeContext
    >
  >
> {}

export const BackflushProject = Binding.Service<BackflushProject>(
  "Stackit.Telemetry.BackflushProject",
);
