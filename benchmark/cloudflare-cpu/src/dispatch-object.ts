import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { dispatchLoop } from "./dispatch-work.ts";

const implementation = Effect.succeed(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return {
      // Intentionally no child span or storage I/O: measure dispatch overhead.
      noop: () => Effect.succeed(0),
      loop: (count: number) => dispatchLoop(count),
      identity: () => Effect.succeed(state.id.toString()),
    };
  }),
);

/** Separate namespaces keep each tracing cohort on one stable actor. */
export class PlainDispatchObject extends Cloudflare.DurableObject<PlainDispatchObject>()(
  "PlainDispatchObject",
  implementation,
) {}

export class TracedDispatchObject extends Cloudflare.DurableObject<TracedDispatchObject>()(
  "TracedDispatchObject",
  implementation,
) {}
