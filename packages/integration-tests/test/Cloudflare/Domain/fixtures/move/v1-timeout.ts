import * as Cloudflare from "@alchemy.run/cloudflare";
import { moveWorker } from "./worker.ts";

/** The move's Worker at layout 1, whose deploy stops waiting for the move after a second. */
export default class DomainMoveV1TimeoutWorker extends Cloudflare.Worker<DomainMoveV1TimeoutWorker>()(
  "DomainMoveWorker",
  { main: import.meta.url },
  moveWorker("v1", 1, { timeout: "1 second" }),
) {}
