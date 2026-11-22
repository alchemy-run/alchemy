/**
 * OpenCode on Cloudflare: a harness in a Durable Object.
 *
 * @module
 */
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Instance } from "../Instance.ts";

/**
 * Key a harness's sandboxes on the id of the Durable Object that yields it,
 * so two objects with a session of the same name never share a sandbox.
 *
 * **Example:** A harness in a Durable Object
 * ```typescript
 * const HarnessLive = Layer.mergeAll(ModelsLive, SandboxLive, OpenCodeCloudflare.DurableObjectInstance);
 * ```
 *
 * @layer
 * @provides OpenCode.Instance
 */
export const DurableObjectInstance: Layer.Layer<Instance> = Layer.succeed(Instance, {
  // At plan time the state is a stand-in with no id, and nothing opens a sandbox.
  id: Effect.map(Effect.serviceOption(DurableObjectState), (state) =>
    Option.match(state, { onNone: () => "", onSome: (state) => state.id?.toString() ?? "" }),
  ),
});
