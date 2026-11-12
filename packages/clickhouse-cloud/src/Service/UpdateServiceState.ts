import type * as service from "@distilled.cloud/clickhouse-cloud/service";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../internal/Errors.ts";
import type { Service } from "./Service.ts";

/**
 * A command that changes a service's state: `start` a stopped service,
 * `stop` a running one, or `awake` an idle one.
 */
export type ServiceStateCommand = "start" | "stop" | "awake";

/**
 * Start, stop, or wake a ClickHouse Cloud service at runtime, e.g. wake an
 * idle service before a burst of queries, or stop it from a scheduled job
 * at night. The call returns once ClickHouse accepts the command; the
 * state change itself is asynchronous.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view` and `control-plane:service:manage` on the
 * bound service (`manage` alone is refused). ClickHouse Cloud
 * federates no workload identity, so a key is the only way in.
 *
 * :::caution
 * A stack whose `ClickHouseCloud.Service.Service` declares `state` puts the
 * service back in that state on the next deploy.
 * :::
 *
 * ### Changing the State
 * **Example:** Wake the service before a report runs
 * ```typescript
 * export const Analytics = ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 *   idleScaling: true,
 * });
 *
 * export default class Reports extends Cloudflare.Worker<Reports>()(
 *   "Reports",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: grants control-plane:service:view and :manage on the service
 *     const updateState = yield* ClickHouseCloud.Service.UpdateServiceState(Analytics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const svc = yield* updateState("awake");
 *         return yield* HttpServerResponse.json({ state: svc.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Service.UpdateServiceStateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Service
 */
export interface UpdateServiceState extends Binding.Service<
  UpdateServiceState,
  "ClickHouseCloud.Service.UpdateServiceState",
  (
    target: Service,
  ) => Effect.Effect<
    (
      command: ServiceStateCommand,
    ) => Effect.Effect<
      service.Service,
      service.UpdateServiceStateError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const UpdateServiceState = Binding.Service<UpdateServiceState>(
  "ClickHouseCloud.Service.UpdateServiceState",
);
