import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Graph } from "./Graph.ts";

/**
 * Dashboard UI providers for AWS NeptuneGraph resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const GraphUI = UIProvider.succeed<Graph>("AWS.NeptuneGraph.Graph", {
  displayName: "Neptune Analytics Graph",
  icon: "waypoints",
  color: "#C925D1",
  category: "database",
  summary: (ctx) => ctx.attrs?.graphName,
  facts: (ctx) => [
    { label: "graph", value: ctx.attrs?.graphName, copy: true },
    { label: "id", value: ctx.attrs?.graphId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.graphArn, mono: true, copy: true },
    { label: "endpoint", value: ctx.attrs?.endpoint, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "provisioned memory", value: ctx.attrs?.provisionedMemory },
    { label: "public", value: ctx.attrs?.publicConnectivity },
  ],
});

export const ui = () => Layer.mergeAll(GraphUI);
