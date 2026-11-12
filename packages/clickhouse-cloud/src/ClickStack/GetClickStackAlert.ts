import type * as stack from "@distilled.cloud/clickhouse-cloud/click_stack";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Alert } from "./Alert.ts";

/**
 * Read a ClickStack alert at runtime: its live `state` (`ALERT`, `OK`,
 * `PENDING`, `INSUFFICIENT_DATA`, `DISABLED`), whether it is silenced, and
 * its last execution errors. Use it for status pages and deploy gates.
 * The endpoint is in beta.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view` and
 * `control-plane:service:manage-clickstack-api` on the alert's service (the
 * ClickStack API has no read-only permission). ClickHouse Cloud federates
 * no workload identity, so a key is the only way in.
 *
 * ### Gating on an Alert
 * **Example:** Refuse a release while the alert fires
 * ```typescript
 * export default class Gate extends Cloudflare.Worker<Gate>()(
 *   "Gate",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getAlert = yield* ClickHouseCloud.ClickStack.GetClickStackAlert(TooManyErrors);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const alert = yield* getAlert();
 *         return yield* HttpServerResponse.json({ ok: alert.state !== "ALERT" });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.ClickStack.GetClickStackAlertHttp)),
 * ) {}
 * ```
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `getClickStackAlert`.
 *
 * @binding
 * @product ClickStack
 */
export interface GetClickStackAlert extends Binding.Service<
  GetClickStackAlert,
  "ClickHouseCloud.ClickStack.GetClickStackAlert",
  (
    target: Alert,
  ) => Effect.Effect<
    () => Effect.Effect<
      stack.ClickStackAlertResponse,
      stack.GetClickStackAlertError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const GetClickStackAlert = Binding.Service<GetClickStackAlert>(
  "ClickHouseCloud.ClickStack.GetClickStackAlert",
);
