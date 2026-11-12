import type * as pipes from "@distilled.cloud/clickhouse-cloud/click_pipes";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { ClickPipe } from "./ClickPipe.ts";

/**
 * Read a ClickPipe at runtime: its live state (`Running`, `Degraded`,
 * `Failed`, …), scaling and configuration. Use it for health checks and
 * alerting on ingestion.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view` and `control-plane:service:manage-clickpipes`
 * on the pipe's service: reading a pipe needs the manage permission (no
 * narrower one exists). ClickHouse Cloud federates no workload identity, so
 * a key is the only way in.
 *
 * ### Checking a Pipe
 * **Example:** Whether ingestion runs
 * ```typescript
 * export default class Health extends Cloudflare.Worker<Health>()(
 *   "Health",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getClickPipe = yield* ClickHouseCloud.ClickPipes.GetClickPipe(Events);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const pipe = yield* getClickPipe();
 *         return yield* HttpServerResponse.json({ state: pipe.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.ClickPipes.GetClickPipeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product ClickPipes
 */
export interface GetClickPipe extends Binding.Service<
  GetClickPipe,
  "ClickHouseCloud.ClickPipes.GetClickPipe",
  (
    target: ClickPipe,
  ) => Effect.Effect<
    () => Effect.Effect<pipes.ClickPipe, pipes.GetClickPipeError | ResultMissing, RuntimeContext>
  >
> {}

export const GetClickPipe = Binding.Service<GetClickPipe>(
  "ClickHouseCloud.ClickPipes.GetClickPipe",
);
