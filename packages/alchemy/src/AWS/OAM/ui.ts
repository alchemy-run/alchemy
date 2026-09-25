import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Link } from "./Link.ts";
import type { Sink } from "./Sink.ts";

/**
 * Dashboard UI providers for AWS OAM (CloudWatch Observability Access
 * Manager) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const LinkUI = UIProvider.succeed<Link>("AWS.OAM.Link", {
  displayName: "OAM Link",
  icon: "share-2",
  color: "#E7157B",
  category: "observability",
  summary: (ctx) => ctx.attrs?.label,
  facts: (ctx) => [
    { label: "label", value: ctx.attrs?.label, copy: true },
    { label: "arn", value: ctx.attrs?.linkArn, mono: true, copy: true },
    { label: "id", value: ctx.attrs?.linkId, mono: true },
    { label: "sink", value: ctx.attrs?.sinkArn, mono: true, copy: true },
    {
      label: "resource types",
      value: ctx.props?.resourceTypes?.join(", "),
    },
  ],
});

export const SinkUI = UIProvider.succeed<Sink>("AWS.OAM.Sink", {
  displayName: "OAM Sink",
  icon: "inbox",
  color: "#E7157B",
  category: "observability",
  summary: (ctx) => ctx.attrs?.sinkName,
  facts: (ctx) => [
    { label: "sink", value: ctx.attrs?.sinkName, copy: true },
    { label: "arn", value: ctx.attrs?.sinkArn, mono: true, copy: true },
    { label: "id", value: ctx.attrs?.sinkId, mono: true },
  ],
});

export const ui = () => Layer.mergeAll(LinkUI, SinkUI);
