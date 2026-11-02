import type * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface TriggerRestoreRequest extends Omit<
  rabbitmq.TriggerRestoreRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for RabbitMQ `triggerRestore`: restore an instance from one of its
 * backups.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link TriggerRestoreHttp}. The instance's project, region and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it. This goes through STACKIT's API, so the instance's ACL doesn't apply.
 *
 * Access: a custom role with `rabbitmq.proxy.write`, the permission the spec names for this
 * operation, on the project holding the instance. STACKIT binds roles on nothing
 * narrower, so it reaches every RabbitMQ instance in the project.
 *
 * ### Restoring a Backup
 * **Example:** Restore a backup from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Broker = Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["0.0.0.0/0"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const broker = yield* Broker;
 *     const triggerRestore = yield* Stackit.RabbitMQ.TriggerRestore(broker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const restore = yield* triggerRestore({ backupId: 1 });
 *         return yield* HttpServerResponse.json({ id: restore.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.TriggerRestoreHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface TriggerRestore extends Binding.Service<
  TriggerRestore,
  "Stackit.RabbitMQ.TriggerRestore",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: TriggerRestoreRequest,
    ) => Effect.Effect<
      rabbitmq.TriggerRestoreResponse,
      rabbitmq.TriggerRestoreError,
      RuntimeContext
    >
  >
> {}

export const TriggerRestore = Binding.Service<TriggerRestore>("Stackit.RabbitMQ.TriggerRestore");
