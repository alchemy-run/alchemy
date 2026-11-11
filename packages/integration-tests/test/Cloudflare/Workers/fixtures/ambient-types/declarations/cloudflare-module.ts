import * as Cloudflare from "@alchemy.run/cloudflare";
import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";

// A helper written against the module export.
const describe = (ctx: cf.DurableObjectState): string => ctx.id.toString();

export const program = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  describe(state.raw);
  // `raw` round-trips through alchemy's converter.
  Cloudflare.fromDurableObjectState(state.raw);
  // @ts-expect-error `raw` stays strictly typed, never `any`.
  const notANumber: number = state.raw;
  return notANumber;
});
