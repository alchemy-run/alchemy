import type * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface TriggerRecreateRequest extends Omit<
  rabbitmq.TriggerRecreateRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for RabbitMQ `triggerRecreate`: recreate an instance's VMs, to
 * recover it.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link TriggerRecreateHttp}. The instance's project, region and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it. This goes through STACKIT's API, so the instance's ACL doesn't apply.
 *
 * Access: a custom role with `rabbitmq.proxy.write`, the permission the spec names for this
 * operation, on the project holding the instance. STACKIT binds roles on nothing
 * narrower, so it reaches every RabbitMQ instance in the project.
 *
 * ### Recreating the Instance
 * **Example:** Recreate the instance from a Cloudflare Worker
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
 *     const triggerRecreate = yield* Stackit.RabbitMQ.TriggerRecreate(broker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* triggerRecreate({});
 *         return yield* HttpServerResponse.json({ recreating: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.TriggerRecreateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface TriggerRecreate extends Binding.Service<
  TriggerRecreate,
  "Stackit.RabbitMQ.TriggerRecreate",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: TriggerRecreateRequest,
    ) => Effect.Effect<
      rabbitmq.CreateInstanceResponse,
      rabbitmq.TriggerRecreateError,
      RuntimeContext
    >
  >
> {}

export const TriggerRecreate = Binding.Service<TriggerRecreate>("Stackit.RabbitMQ.TriggerRecreate");
