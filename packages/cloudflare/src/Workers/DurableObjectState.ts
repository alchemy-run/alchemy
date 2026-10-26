import type * as cf from "@cloudflare/workers-types";
import {
  fromDurableObjectState as fromWorkerdDurableObjectState,
  type WorkerdDurableObjectState,
} from "alchemy/Workers/Workerd/DurableObjectState";
import * as Context from "effect/Context";
import {
  getLoopbackEntrypoint,
  makeEntrypointExports,
  type EntrypointExports,
} from "./WorkerRuntime.ts";

export {
  BackgroundWork,
  type DurableObjectAbortOptions,
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

export const fromDurableObjectState = (
  state: cf.DurableObjectState,
): DurableObjectState["Service"] => ({
  ...fromWorkerdDurableObjectState(state),
  exports: makeEntrypointExports((name, options) =>
    getLoopbackEntrypoint(state.exports, name, options),
  ),
});
