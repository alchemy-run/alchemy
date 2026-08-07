import * as Alchemy from "@/index.ts";

/** Tag-only portable Worker class — the deployment target arrives in the
 * deployable module's impl layer stack. */
export class CellsWorker extends Alchemy.Worker<CellsWorker>()("CellsWorker") {}
