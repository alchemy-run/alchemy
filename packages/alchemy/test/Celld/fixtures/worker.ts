import * as Alchemy from "@/index.ts";

/**
 * Tag-only portable Worker class — the deployment target arrives in the
 * deployable module's impl layer stack ([fleet.ts](./fleet.ts)). Keeping
 * the tag in its own module is what makes `counter.ts` (which binds its
 * layer to this worker) and `fleet.ts` (which provides that layer)
 * acyclic. The single-file inline form lives in `worker-inline.ts`.
 */
export class CellsWorker extends Alchemy.Worker<CellsWorker>()("CellsWorker") {}
