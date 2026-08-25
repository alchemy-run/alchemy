import * as Rivet from "@/Rivet";

/** The cluster: infrastructure only (the Rivet Engine via the registered host). */
export class IngressActors extends Rivet.Cluster<IngressActors>()(
  "IngressActors",
) {}

/**
 * The exposed worker's tag. Kept in its own module so the deploy module
 * ([worker.ts](./worker.ts)) and the test stay acyclic.
 */
export class IngressWorker extends Rivet.Worker<IngressWorker>()(
  "IngressWorker",
) {}
