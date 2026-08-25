import * as Celld from "@/Celld";

/** The fleet: infrastructure only (nodes + bucket via the registered host). */
export class ConformanceCells extends Celld.Fleet<ConformanceCells>()(
  "ConformanceCells",
  { instances: 1 },
) {}

/**
 * The Celld worker tag. Kept in its own module so the deploy module
 * ([worker.ts](./worker.ts)) and the Lambda caller ([api.ts](./api.ts))
 * stay acyclic — the caller imports only this tag, never the impl.
 */
export class ConformanceWorker extends Celld.Worker<ConformanceWorker>()(
  "ConformanceWorker",
) {}
