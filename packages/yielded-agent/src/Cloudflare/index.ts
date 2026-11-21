/**
 * Yielded Agent on Cloudflare: Thread history in a Durable Object's SQLite.
 *
 * @module
 */
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import { PersistentHistory } from "@yielded/agent";
import { DoThreadStore } from "@yielded/agent-storage-cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { YieldedAgentError } from "../Errors.ts";
import { History } from "../History.ts";

/**
 * Threads in the Durable Object's own SQLite. Each successful Run is
 * committed as one batch, so a Thread continues after the instance is
 * evicted or redeployed. A Run cut off before it finishes leaves nothing
 * behind and is not resumed: submit it again.
 *
 * **Example:** A harness whose Threads outlive the instance
 * ```typescript
 * const HarnessLive = Layer.mergeAll(FastLive, AddLive, YieldedCloudflare.DurableObjectHistory);
 * ```
 *
 * @layer
 * @provides YieldedAgent.History
 * @peer @yielded/agent-storage-cloudflare
 */
export const DurableObjectHistory: Layer.Layer<History> = Layer.succeed(History, {
  instance: Effect.map(Effect.serviceOption(DurableObjectState), (state) => ({
    // At plan time the state is a stand-in with no id, and nothing builds the history.
    id: Option.match(state, { onNone: () => "", onSome: (state) => state.id?.toString() ?? "" }),
    layer: Option.isNone(state)
      ? Layer.effectContext(
          new YieldedAgentError({
            message:
              "YieldedCloudflare.DurableObjectHistory is only available inside a Durable Object",
          }).pipe(Effect.fail),
        )
      : PersistentHistory.layer.pipe(
          Layer.provide(
            DoThreadStore.layer({
              storage: (state.value.raw as unknown as { storage: never }).storage,
            }),
          ),
        ),
  })),
});
