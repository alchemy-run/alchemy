import type * as cf from "@cloudflare/workers-types";
import {
  fromDurableObjectState as fromWorkerdDurableObjectState,
  type NativeDurableObjectState,
  type WorkerdDurableObjectState,
} from "alchemy/Workers/Workerd/DurableObjectState";
import * as Context from "effect/Context";
import {
  getLoopbackEntrypoint,
  makeEntrypointExports,
  type EntrypointExports,
} from "./WorkerRuntime.ts";

export {
  type DurableObjectAbortOptions,
  type NativeDurableObjectState,
} from "alchemy/Workers/Workerd/DurableObjectState";

export class DurableObjectState extends Context.Service<
  DurableObjectState,
  WorkerdDurableObjectState & {
    /**
     * The entrypoints of the Worker hosting this Durable Object (workerd's
     * `ctx.exports`): `yield* ctx.exports.default({ props })` mints a stub to
     * the host Worker's own Effect handlers that delivers `props` as the
     * target's `ctx.props`. The `Cloudflare.Fetcher` can be passed to APIs that
     * route traffic to a Worker entrypoint, such as this object's container
     * `interceptOutboundHttps`; its `raw` is the native `Fetcher`.
     */
    readonly exports: EntrypointExports;
  }
>()("Cloudflare.DurableObjectState") {}

/**
 * Wrap a native `DurableObjectState` in the Cloudflare Effect view. Takes the
 * same declaration `raw` has, so `fromDurableObjectState(state.raw)`
 * round-trips without TypeScript comparing the two (see
 * `NativeDurableObjectState`).
 */
export const fromDurableObjectState = (
  native: NativeDurableObjectState,
): DurableObjectState["Service"] => {
  const state = native as unknown as cf.DurableObjectState;
  return {
    ...fromWorkerdDurableObjectState(native),
    exports: makeEntrypointExports((name, options) =>
      getLoopbackEntrypoint(state.exports, name, options),
    ),
  };
};
