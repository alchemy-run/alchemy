import * as Alchemy from "@/index.ts";

/**
 * Tag-only portable Worker class — the deployment target arrives in the
 * deployable module's impl layer stack ([main.ts](./main.ts)). Keeping the
 * tag in its own module is what makes `counter.ts` (which binds its layer
 * to this worker) and `main.ts` (which provides that layer) acyclic.
 */
export class ActorWorker extends Alchemy.Worker<ActorWorker>()("ActorWorker") {}
