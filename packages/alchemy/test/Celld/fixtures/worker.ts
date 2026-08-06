import * as Celld from "@/Celld";

/** Tag-only Worker class — no impl/main here, so imports stay acyclic. */
export class CellsWorker extends Celld.Worker<CellsWorker>()("CellsWorker") {}
