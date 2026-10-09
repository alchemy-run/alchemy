import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CatalogSync } from "./CatalogSync.ts";
import type { CloudIntegration } from "./CloudIntegration.ts";
import type { OnRamp } from "./OnRamp.ts";

/**
 * Dashboard UI providers for Cloudflare MagicCloudNetworking resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const CatalogSyncUI = UIProvider.succeed<CatalogSync>(
  "Cloudflare.MagicCloudNetworking.CatalogSync",
  {
    displayName: "Magic Catalog Sync",
    icon: "refresh-cw",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      { label: "sync id", value: ctx.attrs?.syncId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      {
        label: "destination type",
        value: ctx.attrs?.destinationType ?? ctx.props?.destinationType,
      },
      {
        label: "destination id",
        value: ctx.attrs?.destinationId,
        mono: true,
        copy: true,
      },
      {
        label: "update mode",
        value: ctx.attrs?.updateMode ?? ctx.props?.updateMode,
      },
      { label: "policy", value: ctx.attrs?.policy, mono: true },
      { label: "last update", value: ctx.attrs?.lastUserUpdateAt, mono: true },
    ],
  },
);

export const CloudIntegrationUI = UIProvider.succeed<CloudIntegration>(
  "Cloudflare.MagicCloudNetworking.CloudIntegration",
  {
    displayName: "Cloud Integration",
    icon: "cloud",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.friendlyName ?? ctx.props?.friendlyName,
    facts: (ctx) => [
      {
        label: "integration id",
        value: ctx.attrs?.integrationId,
        mono: true,
        copy: true,
      },
      {
        label: "name",
        value: ctx.attrs?.friendlyName ?? ctx.props?.friendlyName,
      },
      {
        label: "cloud",
        value: ctx.attrs?.cloudType ?? ctx.props?.cloudType,
      },
      { label: "lifecycle", value: ctx.attrs?.lifecycleState },
      { label: "state", value: ctx.attrs?.state },
      { label: "aws arn", value: ctx.attrs?.awsArn, mono: true, copy: true },
      {
        label: "azure subscription",
        value: ctx.attrs?.azureSubscriptionId,
        mono: true,
        copy: true,
      },
      {
        label: "gcp project",
        value: ctx.attrs?.gcpProjectId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const OnRampUI = UIProvider.succeed<OnRamp>(
  "Cloudflare.MagicCloudNetworking.OnRamp",
  {
    displayName: "Magic On-Ramp",
    icon: "arrow-up-right",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      {
        label: "on-ramp id",
        value: ctx.attrs?.onRampId,
        mono: true,
        copy: true,
      },
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      { label: "cloud", value: ctx.attrs?.cloudType ?? ctx.props?.cloudType },
      { label: "type", value: ctx.attrs?.type ?? ctx.props?.type },
      { label: "vpc", value: ctx.attrs?.vpc, mono: true, copy: true },
      { label: "cloud asn", value: ctx.attrs?.cloudAsn, mono: true },
      {
        label: "dynamic routing",
        value: ctx.attrs?.dynamicRouting ?? ctx.props?.dynamicRouting,
      },
      {
        label: "attached vpcs",
        value: ctx.attrs?.attachedVpcs?.length
          ? ctx.attrs.attachedVpcs.join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(CatalogSyncUI, CloudIntegrationUI, OnRampUI);
