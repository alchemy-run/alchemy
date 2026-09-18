import * as Rivet from "@/Rivet";

/** The cluster: infrastructure only (the Rivet Engine via the registered host). */
export class ConformanceActors extends Rivet.Cluster<ConformanceActors>()(
  "ConformanceActors",
) {}

/**
 * The Rivet worker tag. Kept in its own module so the deploy module
 * ([worker.ts](./worker.ts)) and the Lambda caller ([api.ts](./api.ts))
 * stay acyclic — the caller imports only this tag, never the impl.
 */
export class ConformanceWorker extends Rivet.Worker<ConformanceWorker>()(
  "ConformanceWorker",
) {}
