import type * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Link } from "./Link.ts";

export interface BackflushFolderRequest extends Omit<
  telemetry.CreateFolderBackflushJobRequest,
  "folderId" | "regionId"
> {}

/**
 * Runtime binding for Telemetry Link `createFolderBackflushJob`: start a backflush job
 * on the folder's link, from a runtime or a script. STACKIT describes it only as
 * creating a backflush job; what it replays, and from when, is not documented. A job
 * has no delete or cancel.
 *
 * Bind this operation to a {@link Link} whose `scope` is a folder in a Function/Worker
 * init phase and provide {@link BackflushFolderHttp}. The link's folder and region are
 * injected into each request. Binding it to a link of another scope fails the deploy.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-link.instance.update`, on the folder.
 * STACKIT binds roles on projects, folders and organizations, and a link has no finer
 * scope. The deployer needs `iam.role.add` on the folder to define it.
 *
 * ### Starting a Backflush
 * **Example:** Start a job on the folder's link from a Cloudflare Worker
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
 *     const backflushFolder = yield* Stackit.Telemetry.BackflushFolder(yield* Audit);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* backflushFolder({ displayName: "replay" });
 *         return yield* HttpServerResponse.json({ id: result.id, status: result.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.BackflushFolderHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface BackflushFolder extends Binding.Service<
  BackflushFolder,
  "Stackit.Telemetry.BackflushFolder",
  (
    link: Link,
  ) => Effect.Effect<
    (
      request?: BackflushFolderRequest,
    ) => Effect.Effect<
      telemetry.BackflushJobResponse,
      telemetry.CreateFolderBackflushJobError,
      RuntimeContext
    >
  >
> {}

export const BackflushFolder = Binding.Service<BackflushFolder>(
  "Stackit.Telemetry.BackflushFolder",
);
