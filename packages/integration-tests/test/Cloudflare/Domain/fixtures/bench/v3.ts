import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Deposits } from "../catch-up/ledger.ts";
import { After, benchWorker, hosted } from "./worker.ts";

/** The view at version 1: rebuilt from the history. */
export default class DomainBenchWorker extends Cloudflare.Worker<DomainBenchWorker>()(
  "DomainBenchWorker",
  { main: import.meta.url },
  benchWorker("v3", { kind: "deposits", view: Deposits }).pipe(
    Effect.provide(hosted(After.layer({ versions: { Deposits: 1 } }, Layer.empty))),
  ),
) {}
