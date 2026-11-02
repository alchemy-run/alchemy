import type * as logme from "@distilled.cloud/stackit/logme";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetUpdatesRequest extends Omit<
  logme.GetUpdatesRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT LogMe `getUpdates`: read whether automatic updates are on
 * and how many updates are available.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetUpdatesHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `logme.proxy.read`, bound on the
 * project holding the instance. STACKIT binds roles on projects at the narrowest, so
 * the permission reaches every STACKIT LogMe instance in that project. STACKIT gates
 * backups, metrics, restarts and updates behind this one permission, so it allows all
 * of the reads in that group.
 *
 * ### Calling `getUpdates`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.LogMe.Instance("Logs", {
 *   version: "2",
 *   planName: "stackit-logme2-1.2.50-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const instance = yield* Logs;
 *     const getUpdates = yield* Stackit.LogMe.GetUpdates(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const updates = yield* getUpdates({});
 *         return yield* HttpServerResponse.json({ available: updates.availableUpdates });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LogMe.GetUpdatesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category LogMe
 */
export interface GetUpdates extends Binding.Service<
  GetUpdates,
  "Stackit.LogMe.GetUpdates",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetUpdatesRequest,
    ) => Effect.Effect<logme.GetUpdatesResponse, logme.GetUpdatesError, RuntimeContext>
  >
> {}

export const GetUpdates = Binding.Service<GetUpdates>("Stackit.LogMe.GetUpdates");
