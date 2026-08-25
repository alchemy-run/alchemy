import * as Celld from "@/Celld";

/**
 * The Celld worker tag — the deployment (props + impl) arrives in the
 * deploy module ([fleet.ts](./fleet.ts)) via `.make`. Keeping the tag in
 * its own module is what makes `api.ts` (which binds to this worker) and
 * `fleet.ts` (which provides the impl) acyclic. The single-file inline
 * form lives in `worker-inline.ts`.
 */
export class CellsWorker extends Celld.Worker<CellsWorker>()("CellsWorker") {}
