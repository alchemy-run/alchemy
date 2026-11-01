import type * as valkey from "@distilled.cloud/stackit/valkey";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CreateBackupRequest extends Omit<
  valkey.CreateBackupRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Key Value Store `createBackup`: start an on-demand backup of the instance.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link CreateBackupHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `key-value-store.proxy.write`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every Key Value Store instance in that project.
 * STACKIT gates backups, metrics, restarts and updates behind this one permission, so it
 * allows all of the changes in that group.
 *
 * ### Calling `createBackup`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Cache = Stackit.Valkey.Instance("Cache", {
 *   version: "x",
 *   planName: "stackit-keyvalue-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const instance = yield* Cache;
 *     const createBackup = yield* Stackit.Valkey.CreateBackup(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const backup = yield* createBackup({});
 *         return yield* HttpServerResponse.json({ id: backup.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Valkey.CreateBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Valkey
 */
export interface CreateBackup extends Binding.Service<
  CreateBackup,
  "Stackit.Valkey.CreateBackup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: CreateBackupRequest,
    ) => Effect.Effect<valkey.CreateBackupResponseItem, valkey.CreateBackupError, RuntimeContext>
  >
> {}

export const CreateBackup = Binding.Service<CreateBackup>("Stackit.Valkey.CreateBackup");
