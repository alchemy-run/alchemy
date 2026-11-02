import type * as logme from "@distilled.cloud/stackit/logme";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CreateBackupRequest extends Omit<
  logme.CreateBackupRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT LogMe `createBackup`: start an on-demand backup of the
 * instance.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link CreateBackupHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `logme.proxy.write`, bound on the
 * project holding the instance. STACKIT binds roles on projects at the narrowest, so
 * the permission reaches every STACKIT LogMe instance in that project. STACKIT gates
 * backups, metrics, restarts and updates behind this one permission, so it allows all
 * of the changes in that group.
 *
 * ### Calling `createBackup`
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
 *     const createBackup = yield* Stackit.LogMe.CreateBackup(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const backup = yield* createBackup({});
 *         return yield* HttpServerResponse.json({ backup });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LogMe.CreateBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category LogMe
 */
export interface CreateBackup extends Binding.Service<
  CreateBackup,
  "Stackit.LogMe.CreateBackup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: CreateBackupRequest,
    ) => Effect.Effect<logme.CreateBackupResponseItem, logme.CreateBackupError, RuntimeContext>
  >
> {}

export const CreateBackup = Binding.Service<CreateBackup>("Stackit.LogMe.CreateBackup");
