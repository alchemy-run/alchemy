import type * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Link } from "./Link.ts";

export interface GetFolderBackflushJobRequest extends Omit<
  telemetry.GetFolderBackflushJobRequest,
  "folderId" | "regionId"
> {}

/**
 * Runtime binding for Telemetry Link `getFolderBackflushJob`: poll a backflush job on
 * the folder's link by its id: `active`, `complete`, `failed`, `reconciling` or
 * `deleting`.
 *
 * Bind this operation to a {@link Link} whose `scope` is a folder in a Function/Worker
 * init phase and provide {@link GetFolderBackflushJobHttp}. The link's folder and
 * region are injected into each request. Binding it to a link of another scope fails
 * the deploy. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-link.instance.get`, on the folder.
 * STACKIT binds roles on projects, folders and organizations, and a link has no finer
 * scope. The deployer needs `iam.role.add` on the folder to define it.
 *
 * ### Polling a Backflush
 * **Example:** Read a job's status from a Cloudflare Worker
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
 *   return yield* Stackit.Telemetry.Link("AuditFolder", {
 *     scope: { folderId: "00000000-0000-0000-0000-000000000000" },
 *     routerId: router.routerId,
 *     accessToken: token.accessToken,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getFolderBackflushJob = yield* Stackit.Telemetry.GetFolderBackflushJob(yield* Audit);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* getFolderBackflushJob({ backflushJobId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ status: result.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.GetFolderBackflushJobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface GetFolderBackflushJob extends Binding.Service<
  GetFolderBackflushJob,
  "Stackit.Telemetry.GetFolderBackflushJob",
  (
    link: Link,
  ) => Effect.Effect<
    (
      request: GetFolderBackflushJobRequest,
    ) => Effect.Effect<
      telemetry.BackflushJobResponse,
      telemetry.GetFolderBackflushJobError,
      RuntimeContext
    >
  >
> {}

export const GetFolderBackflushJob = Binding.Service<GetFolderBackflushJob>(
  "Stackit.Telemetry.GetFolderBackflushJob",
);
