import * as Rivet from "@/Rivet";

/**
 * The Rivet worker tag — the deployment (props + impl) arrives in the
 * deploy module ([main.ts](./main.ts)) via `.make`. Keeping the tag in
 * its own module is what makes callers (which bind to this worker) and
 * `main.ts` (which provides the impl) acyclic.
 */
export class ActorWorker extends Rivet.Worker<ActorWorker>()("ActorWorker") {}
