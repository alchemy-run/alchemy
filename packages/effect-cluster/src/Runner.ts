/**
 * Run the current process as one Effect Cluster runner. Use it when the
 * host starts runners itself (systemd, a process manager, a plain
 * `node runner.mjs`) instead of a pool host like `ClusterDocker.SwarmPool`.
 *
 * @module
 */
import { bootstrap } from "./internal/Bootstrap.ts";

/**
 * Build each entry's Construction phase, then serve its entities, workflows,
 * singletons and crons on this process until it is stopped. Each entry is
 * what a pool runs: an entity class, or the Layer its `.make(...)` returned.
 *
 * The runner reads its settings from its environment, as pool runners do:
 * `CLUSTER_DATABASE_URL`, `CLUSTER_GATEWAY_TOKEN`, `CLUSTER_SHARD_GROUPS`,
 * `CLUSTER_AVAILABLE_SHARD_GROUPS`, `CLUSTER_RUNNER_HOST` and the
 * `ALCHEMY_*` stack values. `ClusterProcess.ProcessPool` writes them to a file.
 *
 * ### Running a runner as a plain process
 * **Example:** The runner's entry module
 * ```typescript
 * import * as Runner from "@alchemy.run/effect-cluster/Runner";
 * import CounterLive from "./counter-live.ts";
 *
 * await Runner.run({ Counter: CounterLive });
 * ```
 */
export const run = (entries: Readonly<Record<string, unknown>>): Promise<void> =>
  bootstrap(Object.entries(entries).map(([name, value]) => ({ name, value })));
