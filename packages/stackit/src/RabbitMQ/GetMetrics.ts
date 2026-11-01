import type * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetMetricsRequest extends Omit<
  rabbitmq.GetMetricsRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for RabbitMQ `getMetrics`: read an instance's CPU, memory and disk
 * usage.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetMetricsHttp}. The instance's project, region and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it. This goes through STACKIT's API, so the instance's ACL doesn't apply.
 *
 * Access: a custom role with `rabbitmq.proxy.read`, the permission the spec names for this
 * operation, on the project holding the instance. STACKIT binds roles on nothing
 * narrower, so it reaches every RabbitMQ instance in the project.
 *
 * ### Reading Metrics
 * **Example:** Report memory use from a Cloudflare Worker
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
 *     const getMetrics = yield* Stackit.RabbitMQ.GetMetrics(broker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const metrics = yield* getMetrics({});
 *         return yield* HttpServerResponse.json({ memoryUsed: metrics.memoryUsed });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.GetMetricsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface GetMetrics extends Binding.Service<
  GetMetrics,
  "Stackit.RabbitMQ.GetMetrics",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetMetricsRequest,
    ) => Effect.Effect<rabbitmq.GetMetricsResponse, rabbitmq.GetMetricsError, RuntimeContext>
  >
> {}

export const GetMetrics = Binding.Service<GetMetrics>("Stackit.RabbitMQ.GetMetrics");
