import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { DurableObject } from "../DurableObject.ts";

/**
 * What a pool Layer gives the Effect it is provided to: a way for an
 * external `Rivet.DurableObject` (one with a `main` and no implementation)
 * to run its program on the pool's nodes.
 * @internal
 */
export class PoolHost extends Context.Service<
  PoolHost,
  {
    readonly deployExternal: (object: {
      readonly id: string;
      readonly main: string;
      readonly resource: DurableObject;
    }) => Effect.Effect<void>;
  }
>()("Rivet.PoolHost") {}
