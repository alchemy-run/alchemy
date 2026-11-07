import * as Cloudflare from "@alchemy.run/cloudflare";
import { moveWorker } from "./worker.ts";

/** The move's Worker at layout 1 with a bug: its code fails to start once deployed. */
export default class DomainMoveV1BrokenWorker extends Cloudflare.Worker<DomainMoveV1BrokenWorker>()(
  "DomainMoveWorker",
  { main: import.meta.url },
  moveWorker("v1-broken", 1, { broken: true, timeout: "2 minutes" }),
) {}
