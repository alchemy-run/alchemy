import * as Cloudflare from "@alchemy.run/cloudflare";
import { moveWorker } from "./worker.ts";

/** The move benchmark's Worker at layout 1 (`GET /version` answers `v1b`). */
export default class DomainMoveV1BWorker extends Cloudflare.Worker<DomainMoveV1BWorker>()(
  "DomainMoveWorker",
  { main: import.meta.url },
  moveWorker("v1b", 1),
) {}
