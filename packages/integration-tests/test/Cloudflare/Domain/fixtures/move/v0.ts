import * as Cloudflare from "@alchemy.run/cloudflare";
import { moveWorker } from "./worker.ts";

/** The move benchmark's Worker at layout 0 (`GET /version` answers `v0`). */
export default class DomainMoveV0Worker extends Cloudflare.Worker<DomainMoveV0Worker>()(
  "DomainMoveWorker",
  { main: import.meta.url },
  moveWorker("v0", 0),
) {}
