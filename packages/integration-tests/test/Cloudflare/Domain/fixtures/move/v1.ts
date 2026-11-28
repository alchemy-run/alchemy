import * as Cloudflare from "@alchemy.run/cloudflare";
import { moveWorker } from "./worker.ts";

/** The move benchmark's Worker at layout 1 (`GET /version` answers `v1`). */
export default class DomainMoveV1Worker extends Cloudflare.Worker<DomainMoveV1Worker>()(
  "DomainMoveWorker",
  { main: import.meta.url },
  moveWorker("v1", 1),
) {}
