import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import type { SqlCallFailed } from "../Errors.ts";
import type { Service } from "./Service.ts";

/**
 * Check at runtime that a ClickHouse Cloud service answers on its HTTP
 * interface (`/ping`), e.g. for a health endpoint. An idle service wakes
 * on the first request, so a ping may take a few seconds.
 *
 * The host gets the service's HTTPS URL and the `default` user's password
 * through `RuntimeContext`. Runs on Node.js hosts and on Cloudflare Workers
 * with `nodejs_compat`; install `@effect/sql-clickhouse` and
 * `@effect/platform-node`.
 *
 * ### Health Checks
 * **Example:** A readiness probe
 * ```typescript
 * const ping = yield* ClickHouseCloud.Service.Ping(Analytics);
 * // runtime
 * const ok = yield* ping();
 * ```
 *
 * @binding
 * @product Service
 */
export interface Ping extends Binding.Service<
  Ping,
  "ClickHouseCloud.Service.Ping",
  (
    target: Service,
  ) => Effect.Effect<() => Effect.Effect<boolean, SqlCallFailed | SqlError, RuntimeContext>>
> {}

export const Ping = Binding.Service<Ping>("ClickHouseCloud.Service.Ping");
