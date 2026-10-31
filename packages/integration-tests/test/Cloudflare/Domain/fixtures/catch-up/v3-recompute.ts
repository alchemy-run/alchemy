import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DoubledDeposits, Rebuilt, Timeline } from "./ledger.ts";
import { hosted, ledgerWorker } from "./worker.ts";

/** The view redefined with only a new `evolve`, recomputed in place from each key's own inputs. */
export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  { main: import.meta.url },
  ledgerWorker("v3-recompute", DoubledDeposits, Timeline).pipe(
    Effect.provide(hosted(Rebuilt.layer(Layer.empty, { recompute: { Deposits: 1 } }))),
  ),
) {}
