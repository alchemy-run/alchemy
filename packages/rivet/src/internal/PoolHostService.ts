import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { DurableObject } from "../DurableObject.ts";
import type { CargoBuild } from "./RustProgram.ts";

/**
 * What a pool Layer gives the Effect it is provided to: a way for an
 * external `Rivet.DurableObject` to run its program on the pool's nodes —
 * a RivetKit program (`main`), or a Rust crate (`crate`).
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
    readonly deployCrate: (object: {
      readonly id: string;
      readonly crate: string;
      readonly build: CargoBuild | undefined;
      readonly resource: DurableObject;
    }) => Effect.Effect<void>;
  }
>()("Rivet.PoolHost") {}
