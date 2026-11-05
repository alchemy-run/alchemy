import * as schemas from "@distilled.cloud/aws/schemas";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSchemasDiscovererHttpBinding } from "./BindingHttp.ts";
import type { Discoverer } from "./Discoverer.ts";

/**
 * Runtime binding for `schemas:StartDiscoverer`.
 *
 * Resumes schema discovery on the bound {@link Discoverer} — e.g. an ops
 * function re-enabling discovery after a paused window. The discoverer id is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Schemas.StartDiscovererHttp)`.
 * ### Controlling a Discoverer
 * **Example:** Resume Discovery
 * ```typescript
 * // init — bind the operation to the discoverer
 * const startDiscoverer = yield* AWS.Schemas.StartDiscoverer(discoverer);
 *
 * // runtime
 * const { State } = yield* startDiscoverer();
 * // State === "STARTED"
 * ```
 *
 * @binding
 */
export interface StartDiscoverer extends Binding.Service<
  StartDiscoverer,
  "AWS.Schemas.StartDiscoverer",
  (
    discoverer: Discoverer,
  ) => Effect.Effect<
    () => Effect.Effect<schemas.StartDiscovererResponse, schemas.StartDiscovererError>
  >
> {}
export const StartDiscoverer = Binding.Service<StartDiscoverer>("AWS.Schemas.StartDiscoverer");

export const StartDiscovererHttp = Layer.effect(
  StartDiscoverer,
  makeSchemasDiscovererHttpBinding({
    tag: "AWS.Schemas.StartDiscoverer",
    operation: schemas.startDiscoverer,
    actions: ["schemas:StartDiscoverer"],
    // StartDiscoverer re-enables the discoverer's managed EventBridge rule.
    ruleActions: ["events:EnableRule"],
  }),
);
