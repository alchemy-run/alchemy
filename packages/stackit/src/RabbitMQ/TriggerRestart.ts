import type * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface TriggerRestartRequest extends Omit<
  rabbitmq.TriggerRestartRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for RabbitMQ `triggerRestart`: restart an instance's service.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link TriggerRestartHttp}. The instance's project, region and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it. This goes through STACKIT's API, so the instance's ACL doesn't apply.
 *
 * Access: a custom role with `rabbitmq.proxy.write`, the permission the spec names for this
 * operation, on the project holding the instance. STACKIT binds roles on nothing
 * narrower, so it reaches every RabbitMQ instance in the project.
 *
 * ### Restarting the Instance
 * **Example:** Restart the instance from a Cloudflare Worker
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
 *     const triggerRestart = yield* Stackit.RabbitMQ.TriggerRestart(broker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* triggerRestart({});
 *         return yield* HttpServerResponse.json({ restarting: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.TriggerRestartHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface TriggerRestart extends Binding.Service<
  TriggerRestart,
  "Stackit.RabbitMQ.TriggerRestart",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: TriggerRestartRequest,
    ) => Effect.Effect<
      rabbitmq.CreateInstanceResponse,
      rabbitmq.TriggerRestartError,
      RuntimeContext
    >
  >
> {}

export const TriggerRestart = Binding.Service<TriggerRestart>("Stackit.RabbitMQ.TriggerRestart");
