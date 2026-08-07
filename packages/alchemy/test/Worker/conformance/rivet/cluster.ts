import * as Alchemy from "@/index.ts";
import * as Rivet from "@/Rivet";

/** The cluster: infrastructure only (the Rivet Engine via the registered host). */
export class ConformanceActors extends Rivet.Cluster<ConformanceActors>()(
  "ConformanceActors",
) {}

/**
 * The portable Worker tag. Kept in its own module so the shared counter
 * layer (which binds to it) and the deployable module (which provides the
 * Rivet target) stay acyclic.
 */
export class ConformanceWorker extends Alchemy.Worker<ConformanceWorker>()(
  "ConformanceWorker",
) {}
