import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  fromDurableObjectState,
  type WorkerdDurableObjectState,
} from "alchemy/Workers/Workerd/DurableObjectState";
import * as Effect from "effect/Effect";

// A helper written against the ambient global `DurableObjectState`.
const describe = (ctx: DurableObjectState): string => ctx.id.toString();

declare const workerd: WorkerdDurableObjectState;
describe(workerd.raw);

// `raw` round-trips through alchemy's converters.
fromDurableObjectState(workerd.raw);

export const program = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  describe(state.raw);
  Cloudflare.fromDurableObjectState(state.raw);
  // @ts-expect-error `raw` stays strictly typed, never `any`.
  const notANumber: number = state.raw;
  return notANumber;
});
