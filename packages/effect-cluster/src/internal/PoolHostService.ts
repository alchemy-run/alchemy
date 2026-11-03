import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Entity } from "../Entity.ts";
import type { HostedClass } from "./HostedRuntime.ts";

/**
 * What a pool Layer gives the Effect it is provided to: a way for an
 * external `Cluster.Entity` (an existing Effect Cluster program, referenced
 * by file) to run on the pool.
 * @internal
 */
export class PoolHost extends Context.Service<
  PoolHost,
  {
    /** Host a class (an entity, a workflow) on the pool: its Construction phase is running. */
    readonly host: (self: HostedClass) => Effect.Effect<void>;
    readonly deployExternal: (entity: {
      readonly type: string;
      readonly main: string;
      readonly handler: string;
      readonly program: string;
      readonly resource: Entity;
    }) => Effect.Effect<void>;
  }
>()("Cluster.PoolHost") {}
