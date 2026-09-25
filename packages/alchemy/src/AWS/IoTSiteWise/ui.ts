import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Asset } from "./Asset.ts";
import type { AssetModel } from "./AssetModel.ts";
import type { Gateway } from "./Gateway.ts";

/**
 * Dashboard UI providers for AWS IoTSiteWise resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const IOTSITEWISE_COLOR = "#8C4FFF";

export const AssetUI = UIProvider.succeed<Asset>("AWS.IoTSiteWise.Asset", {
  displayName: "IoT SiteWise Asset",
  icon: "box",
  color: IOTSITEWISE_COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.assetName,
  facts: (ctx) => [
    { label: "asset", value: ctx.attrs?.assetName, copy: true },
    { label: "id", value: ctx.attrs?.assetId, mono: true },
    { label: "arn", value: ctx.attrs?.assetArn, mono: true, copy: true },
    { label: "model", value: ctx.attrs?.assetModelId, mono: true },
    { label: "state", value: ctx.attrs?.state },
  ],
});

export const AssetModelUI = UIProvider.succeed<AssetModel>(
  "AWS.IoTSiteWise.AssetModel",
  {
    displayName: "IoT SiteWise Asset Model",
    icon: "layers",
    color: IOTSITEWISE_COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.assetModelName,
    facts: (ctx) => [
      { label: "model", value: ctx.attrs?.assetModelName, copy: true },
      { label: "id", value: ctx.attrs?.assetModelId, mono: true },
      {
        label: "arn",
        value: ctx.attrs?.assetModelArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.assetModelType },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const GatewayUI = UIProvider.succeed<Gateway>(
  "AWS.IoTSiteWise.Gateway",
  {
    displayName: "IoT SiteWise Gateway",
    icon: "cable",
    color: IOTSITEWISE_COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.gatewayName,
    facts: (ctx) => [
      { label: "gateway", value: ctx.attrs?.gatewayName, copy: true },
      { label: "id", value: ctx.attrs?.gatewayId, mono: true },
      { label: "arn", value: ctx.attrs?.gatewayArn, mono: true, copy: true },
      { label: "version", value: ctx.attrs?.gatewayVersion },
    ],
  },
);

export const ui = () => Layer.mergeAll(AssetUI, AssetModelUI, GatewayUI);
