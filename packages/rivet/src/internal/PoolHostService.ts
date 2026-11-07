import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { DurableObject } from "../DurableObject.ts";
import type { CargoBuild } from "./RustProgram.ts";

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

/**
 * What a pool Layer whose compute builds images from a Dockerfile also
 * gives: a way for a Rust `Rivet.DurableObject` (one with a `crate`) to
 * run its binary on the pool's nodes. Pools that run JavaScript bundles
 * only don't provide it, so giving them a Rust Durable Object is a type
 * error.
 * @internal
 */
export class ImagePoolHost extends Context.Service<
  ImagePoolHost,
  {
    readonly deployCrate: (object: {
      readonly id: string;
      readonly crate: string;
      readonly build: CargoBuild | undefined;
      readonly resource: DurableObject;
    }) => Effect.Effect<void>;
  }
>()("Rivet.ImagePoolHost") {}
