import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Index } from "./ExplorerIndex.ts";
import type { View } from "./View.ts";

/**
 * Dashboard UI providers for AWS Resource Explorer resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance brand pink. */
const COLOR = "#E7157B";

export const IndexUI = UIProvider.succeed<Index>("AWS.ResourceExplorer.Index", {
  displayName: "Resource Explorer Index",
  icon: "database",
  color: COLOR,
  category: "config",
  summary: (ctx) => ctx.attrs?.indexType,
  facts: (ctx) => [
    { label: "arn", value: ctx.attrs?.indexArn, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.indexType },
    { label: "state", value: ctx.attrs?.indexState },
  ],
});

export const ViewUI = UIProvider.succeed<View>("AWS.ResourceExplorer.View", {
  displayName: "Resource Explorer View",
  icon: "search",
  color: COLOR,
  category: "config",
  summary: (ctx) => ctx.attrs?.viewName,
  facts: (ctx) => [
    { label: "view", value: ctx.attrs?.viewName, copy: true },
    { label: "arn", value: ctx.attrs?.viewArn, mono: true, copy: true },
    { label: "scope", value: ctx.attrs?.scope, mono: true },
  ],
});

export const ui = () => Layer.mergeAll(IndexUI, ViewUI);
