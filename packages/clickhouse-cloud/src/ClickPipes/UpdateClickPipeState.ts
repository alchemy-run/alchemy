import type * as pipes from "@distilled.cloud/clickhouse-cloud/click_pipes";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { ClickPipe } from "./ClickPipe.ts";

/**
 * Start, stop or resync a ClickPipe at runtime: pause ingestion during a
 * migration, resume it after, or resync a Postgres or MySQL pipe. A pipe the
 * stack declares `running` is started again by the next deploy.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:service:view`, `control-plane:service:manage-clickpipes` and
 * `sql-console:database:access` (ClickPipes refuse a key without database
 * access) on the pipe's service. ClickHouse Cloud federates no workload identity,
 * so a key is the only way in.
 *
 * ### Pausing Ingestion
 * **Example:** Stop a pipe from a maintenance endpoint
 * ```typescript
 * export default class Maintenance extends Cloudflare.Worker<Maintenance>()(
 *   "Maintenance",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const setState = yield* ClickHouseCloud.ClickPipes.UpdateClickPipeState(Events);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const pipe = yield* setState("stop");
 *         return yield* HttpServerResponse.json({ state: pipe.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.ClickPipes.UpdateClickPipeStateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product ClickPipes
 */
export interface UpdateClickPipeState extends Binding.Service<
  UpdateClickPipeState,
  "ClickHouseCloud.ClickPipes.UpdateClickPipeState",
  (
    target: ClickPipe,
  ) => Effect.Effect<
    (
      command: "start" | "stop" | "resync",
    ) => Effect.Effect<
      pipes.ClickPipe,
      pipes.UpdateClickPipeStateError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const UpdateClickPipeState = Binding.Service<UpdateClickPipeState>(
  "ClickHouseCloud.ClickPipes.UpdateClickPipeState",
);
