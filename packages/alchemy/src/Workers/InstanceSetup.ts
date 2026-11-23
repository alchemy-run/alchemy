/**
 * Per-instance setup registered from a Durable Object's outer Effect.
 *
 * At runtime a Durable Object's outer Effect runs once per instance, but
 * durable callbacks (`Alchemy.makeCallback`) can only be registered in the
 * inner, per-instance Effect. A library that is yielded in the outer Effect
 * (a harness, an engine) registers its instance work here instead, and the
 * bridge runs it at the start of the inner Effect, where callback
 * registration is open. Absent at plan time and on hosts without instances.
 *
 * @module
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";

export class InstanceSetup extends Context.Service<
  InstanceSetup,
  {
    /**
     * Run `effect` at the start of this instance's inner Effect, before the
     * class's own inner code, in registration order.
     */
    readonly add: (effect: Effect.Effect<void, never, RuntimeContext>) => void;
  }
>()("alchemy/Workers/InstanceSetup") {}
