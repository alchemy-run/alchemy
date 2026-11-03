import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Account, Deposits } from "./ledger.ts";
import { hosted, ledgerWorker } from "./worker.ts";

/** The second deploy's model without the timeline: removing a view fills nothing. */
class DepositsOnly extends Domain.Model("Ledger", { aggregates: [Account], views: [Deposits] }) {}

export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  { main: import.meta.url },
  ledgerWorker("v2-deposits", Deposits).pipe(
    Effect.provide(hosted(DepositsOnly.layer(Layer.empty))),
  ),
) {}
