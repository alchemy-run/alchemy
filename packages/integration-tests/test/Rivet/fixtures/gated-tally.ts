/** `Tally`, given `Workers.InputGate`: storage behaves as on Cloudflare. */
import * as Rivet from "@alchemy.run/rivet";
import * as Workers from "alchemy/Workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Default } from "./cluster.ts";
import { TallyImpl } from "./tally.ts";

export default class GatedTally extends Rivet.DurableObject<GatedTally>()(
  "GatedTally",
  { main: import.meta.url },
  TallyImpl.pipe(Effect.provide(Layer.mergeAll(Default, Workers.InputGate))),
) {}
