import * as Celld from "@/Celld";

/**
 * The fleet: infrastructure only (nodes + bucket via the registered host).
 *
 * THREE nodes on purpose: the fleet URL is Cloud Map DNS round-robin over
 * every node, so the conformance run (and the dedicated affinity test)
 * exercises celld's any-node-forwards-to-the-lease-owner routing — a
 * single-node fleet would never leave the owner.
 */
export class ConformanceCells extends Celld.Fleet<ConformanceCells>()(
  "ConformanceCells",
  { instances: 3 },
) {}

/**
 * The Celld worker tag. Kept in its own module so the deploy module
 * ([worker.ts](./worker.ts)) and the Lambda caller ([api.ts](./api.ts))
 * stay acyclic — the caller imports only this tag, never the impl.
 */
export class ConformanceWorker extends Celld.Worker<ConformanceWorker>()(
  "ConformanceWorker",
) {}
