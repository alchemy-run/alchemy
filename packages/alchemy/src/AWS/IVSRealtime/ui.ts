import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Stage } from "./Stage.ts";

/**
 * Dashboard UI providers for AWS IVSRealtime resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Media Services (IVS Real-Time) brand orange. */
const COLOR = "#ED7100";

export const StageUI = UIProvider.succeed<Stage>("AWS.IVSRealtime.Stage", {
  displayName: "IVS Real-Time Stage",
  icon: "video",
  color: COLOR,
  category: "media",
  summary: (ctx) => ctx.attrs?.stageName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.stageName, copy: true },
    { label: "arn", value: ctx.attrs?.stageArn, mono: true, copy: true },
    {
      label: "whip endpoint",
      value: ctx.attrs?.whipEndpoint,
      mono: true,
      copy: true,
    },
    { label: "rtmp endpoint", value: ctx.attrs?.rtmpEndpoint, mono: true },
    { label: "rtmps endpoint", value: ctx.attrs?.rtmpsEndpoint, mono: true },
    { label: "events endpoint", value: ctx.attrs?.eventsEndpoint, mono: true },
  ],
});

export const ui = () => Layer.mergeAll(StageUI);
