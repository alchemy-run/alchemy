import type * as tpu from "@distilled.cloud/gcp/tpu_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Node } from "./Node.ts";

export interface GetNodeRequest extends Omit<
  tpu.GetProjectsLocationsNodesRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud TPU `nodes.get`.
 *
 * Bind this operation to a {@link Node} in a Function/Action init phase.
 * Provide {@link GetNodeHttp}.
 *
 * ### Observing Nodes
 * **Example:** Read the bound node
 * ```typescript
 * const getNode = yield* GCP.Tpu.GetNode(node);
 * const live = yield* getNode();
 * ```
 *
 * @binding
 * @product GCP
 * @category Tpu
 */
export interface GetNode extends Binding.Service<
  GetNode,
  "GCP.Tpu.GetNode",
  (
    node: Node,
  ) => Effect.Effect<
    (
      request?: GetNodeRequest,
    ) => Effect.Effect<
      tpu.Node,
      tpu.GetProjectsLocationsNodesError,
      RuntimeContext
    >
  >
> {}

export const GetNode = Binding.Service<GetNode>("GCP.Tpu.GetNode");
