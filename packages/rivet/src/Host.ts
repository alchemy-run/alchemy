/**
 * The services a Durable Object platform built on Rivet needs from the node
 * and pool it runs on, such as `@alchemy.run/domain/Rivet`.
 *
 * @module
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { DurableObject, HostedDurableObject } from "./DurableObject.ts";
import type { CargoBuild } from "./internal/RustProgram.ts";

/**
 * What a pool Layer gives the Effect it is provided to: a way for an
 * external `Rivet.DurableObject` to run its program on the pool's nodes —
 * a RivetKit program (`main`), or a Rust crate (`crate`).
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

/**
 * The node a Layer is being built on. A node's bootstrap provides it while
 * it builds its entrypoints, so a Layer that hosts a class itself (a Domain
 * platform's, built by the model's Layer rather than exported as a class)
 * hands the node that class. Anywhere else, the service is absent.
 */
export class NodeHost extends Context.Service<
  NodeHost,
  {
    /** Host a class on this node. */
    readonly host: (hosted: HostedDurableObject) => Effect.Effect<void>;
  }
>()("Rivet.NodeHost") {}
