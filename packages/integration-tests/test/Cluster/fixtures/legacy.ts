/** The existing program, deployed as an external entity on a pool of its own. */
import { fileURLToPath } from "node:url";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { Tally as TallyEntity } from "./external/tally.ts";

export const tallyOn = <R>(pool: Cluster.PoolLayer<R>) =>
  Cluster.Entity(TallyEntity, {
    main: fileURLToPath(new URL("./external/tally.ts", import.meta.url)),
    program: fileURLToPath(new URL("./external/runner.ts", import.meta.url)),
  }).pipe(Effect.provide(pool));
