import { fileURLToPath } from "node:url";
/** The existing program, deployed as an external entity on runners of its own. */
import * as Cluster from "@alchemy.run/cluster";
import * as ClusterDocker from "@alchemy.run/cluster/Docker";
import * as Layer from "effect/Layer";
import { Database } from "./cluster.ts";
import { Tally as TallyEntity } from "./external/tally.ts";

export const Legacy = ClusterDocker.Runners("Legacy").pipe(Layer.provide(Database));

export const Tally = Cluster.Entity("Tally", {
  schema: TallyEntity.protocol,
  main: fileURLToPath(new URL("./external/tally.ts", import.meta.url)),
  program: fileURLToPath(new URL("./external/runner.ts", import.meta.url)),
  runners: Legacy,
});
