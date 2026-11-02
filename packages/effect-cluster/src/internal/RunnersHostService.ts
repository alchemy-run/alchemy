import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Entity } from "../Entity.ts";
import type { HostedClass } from "./HostedRuntime.ts";

/**
 * What a runners Layer gives the Effect it is provided to: a way for an
 * external `Cluster.Entity` (an existing Effect Cluster program, referenced
 * by file) to run on the runners.
 * @internal
 */
export class RunnersHost extends Context.Service<
  RunnersHost,
  {
    /** Host a class (an entity, a workflow) on the runners: its Construction phase is running. */
    readonly host: (self: HostedClass) => Effect.Effect<void>;
    readonly deployExternal: (entity: {
      readonly type: string;
      readonly main: string;
      readonly handler: string;
      readonly program: string;
      readonly resource: Entity;
    }) => Effect.Effect<void>;
  }
>()("Cluster.RunnersHost") {}
