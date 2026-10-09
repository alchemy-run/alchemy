import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Graph } from "./Graph.ts";

/**
 * Dashboard UI providers for AWS Detective resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const GraphUI = UIProvider.succeed<Graph>("AWS.Detective.Graph", {
  displayName: "Detective Graph",
  icon: "eye",
  color: "#DD344C",
  category: "security",
  summary: (ctx) => ctx.attrs?.graphArn?.split("/").pop(),
  facts: (ctx) => [
    { label: "arn", value: ctx.attrs?.graphArn, mono: true, copy: true },
    { label: "created", value: ctx.attrs?.createdTime },
  ],
});

export const ui = () => Layer.mergeAll(GraphUI);
