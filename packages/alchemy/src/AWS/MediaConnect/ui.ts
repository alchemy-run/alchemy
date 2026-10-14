import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Flow } from "./Flow.ts";

/**
 * Dashboard UI providers for AWS MediaConnect resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const FlowUI = UIProvider.succeed<Flow>("AWS.MediaConnect.Flow", {
  displayName: "MediaConnect Flow",
  icon: "radio",
  color: "#ED7100",
  category: "media",
  summary: (ctx) => ctx.attrs?.flowName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.flowName, copy: true },
    { label: "arn", value: ctx.attrs?.flowArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "availability zone", value: ctx.attrs?.availabilityZone },
    { label: "egress ip", value: ctx.attrs?.egressIp, mono: true },
    { label: "source ingest ip", value: ctx.attrs?.sourceIngestIp, mono: true },
    { label: "outputs", value: ctx.attrs?.outputs?.length },
  ],
});

export const ui = () => Layer.mergeAll(FlowUI);
