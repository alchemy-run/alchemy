import type * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface TriggerUpdateRequest extends Omit<
  rabbitmq.TriggerUpdateRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for RabbitMQ `triggerUpdate`: start an instance's pending platform
 * updates.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link TriggerUpdateHttp}. The instance's project, region and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it. This goes through STACKIT's API, so the instance's ACL doesn't apply.
 *
 * Access: a custom role with `rabbitmq.proxy.write`, the permission the spec names for this
 * operation, on the project holding the instance. STACKIT binds roles on nothing
 * narrower, so it reaches every RabbitMQ instance in the project.
 *
 * ### Applying Updates
 * **Example:** Start the updates from a Cloudflare Worker
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
 *     const triggerUpdate = yield* Stackit.RabbitMQ.TriggerUpdate(broker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* triggerUpdate({});
 *         return yield* HttpServerResponse.json({ updating: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.TriggerUpdateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface TriggerUpdate extends Binding.Service<
  TriggerUpdate,
  "Stackit.RabbitMQ.TriggerUpdate",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: TriggerUpdateRequest,
    ) => Effect.Effect<rabbitmq.CreateInstanceResponse, rabbitmq.TriggerUpdateError, RuntimeContext>
  >
> {}

export const TriggerUpdate = Binding.Service<TriggerUpdate>("Stackit.RabbitMQ.TriggerUpdate");
