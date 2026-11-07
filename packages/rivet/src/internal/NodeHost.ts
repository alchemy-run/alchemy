/**
 * The node a Layer is being built on. A node's bootstrap provides it while
 * it builds its entrypoints, so a Layer that hosts a class itself (a Domain
 * platform's, built by the model's Layer rather than exported as a class)
 * hands the node that class. Anywhere else, the service is absent.
 *
 * @internal
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { HostedDurableObject } from "../DurableObject.ts";

export class NodeHost extends Context.Service<
  NodeHost,
  {
    /** Host a class on this node. */
    readonly host: (hosted: HostedDurableObject) => Effect.Effect<void>;
  }
>()("Rivet.NodeHost") {}
