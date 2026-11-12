import type * as service from "@distilled.cloud/clickhouse-cloud/service";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Service } from "./Service.ts";

/**
 * Read a ClickHouse Cloud service at runtime: its state (`running`,
 * `idle`, `stopped`, …), endpoints and scaling.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view` on the bound service. ClickHouse Cloud
 * federates no workload identity, so a key is the only way in.
 *
 * ### Reading a Service
 * **Example:** Report whether the service is idle
 * ```typescript
 * export const Analytics = ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: grants control-plane:service:view on the service
 *     const getService = yield* ClickHouseCloud.Service.GetService(Analytics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const svc = yield* getService();
 *         return yield* HttpServerResponse.json({ state: svc.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Service.GetServiceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Service
 */
export interface GetService extends Binding.Service<
  GetService,
  "ClickHouseCloud.Service.GetService",
  (
    target: Service,
  ) => Effect.Effect<
    () => Effect.Effect<service.Service, service.GetServiceError | ResultMissing, RuntimeContext>
  >
> {}

export const GetService = Binding.Service<GetService>("ClickHouseCloud.Service.GetService");
