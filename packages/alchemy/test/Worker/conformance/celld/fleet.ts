import * as Celld from "@/Celld";
import * as Alchemy from "@/index.ts";

/** The fleet: infrastructure only (nodes + bucket via the registered host). */
export class ConformanceCells extends Celld.Fleet<ConformanceCells>()(
  "ConformanceCells",
  { instances: 1 },
) {}

/**
 * The portable Worker tag. Kept in its own module so the shared counter
 * layer (which binds to it) and the deployable module (which provides the
 * celld target) stay acyclic.
 */
export class ConformanceWorker extends Alchemy.Worker<ConformanceWorker>()(
  "ConformanceWorker",
) {}
