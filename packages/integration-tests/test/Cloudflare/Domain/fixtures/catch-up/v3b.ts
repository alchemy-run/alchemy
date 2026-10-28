import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DoubledDeposits, Rebuilt } from "./ledger.ts";
import { hosted, ledgerWorker } from "./worker.ts";

/** The same model as v3 in new code: deployed mid-rebuild, it restarts every object. */
export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  { main: import.meta.url },
  ledgerWorker("v3b", DoubledDeposits).pipe(
    Effect.provide(hosted(Rebuilt.layer(Layer.empty, { versions: { Deposits: 1 } }))),
  ),
) {}
