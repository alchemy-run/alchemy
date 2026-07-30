import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccessPoint } from "./AccessPoint.ts";
import type { AccessPointPolicy } from "./AccessPointPolicy.ts";
import type { MultiRegionAccessPoint } from "./MultiRegionAccessPoint.ts";
import type { ObjectLambdaAccessPoint } from "./ObjectLambdaAccessPoint.ts";
import type { StorageLensConfiguration } from "./StorageLensConfiguration.ts";

/**
 * Dashboard UI providers for AWS S3Control resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Storage brand green. */
const COLOR = "#7AA116";

export const AccessPointUI = UIProvider.succeed<AccessPoint>(
  "AWS.S3Control.AccessPoint",
  {
    displayName: "S3 Access Point",
    icon: "plug",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.accessPointName,
    facts: (ctx) => [
      { label: "access point", value: ctx.attrs?.accessPointName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.accessPointArn,
        mono: true,
        copy: true,
      },
      { label: "alias", value: ctx.attrs?.alias, mono: true },
      { label: "bucket", value: ctx.attrs?.bucket },
      { label: "network origin", value: ctx.attrs?.networkOrigin },
    ],
  },
);

export const AccessPointPolicyUI = UIProvider.succeed<AccessPointPolicy>(
  "AWS.S3Control.AccessPointPolicy",
  {
    displayName: "S3 Access Point Policy",
    icon: "shield",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.accessPointName,
    facts: (ctx) => [
      {
        label: "access point",
        value: ctx.attrs?.accessPointName,
        copy: true,
      },
    ],
  },
);

export const MultiRegionAccessPointUI =
  UIProvider.succeed<MultiRegionAccessPoint>(
    "AWS.S3Control.MultiRegionAccessPoint",
    {
      displayName: "S3 Multi-Region Access Point",
      icon: "globe",
      color: COLOR,
      category: "storage",
      summary: (ctx) => ctx.attrs?.multiRegionAccessPointName,
      facts: (ctx) => [
        {
          label: "access point",
          value: ctx.attrs?.multiRegionAccessPointName,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.multiRegionAccessPointArn,
          mono: true,
          copy: true,
        },
        { label: "alias", value: ctx.attrs?.alias, mono: true, copy: true },
        { label: "status", value: ctx.attrs?.status },
      ],
    },
  );

export const ObjectLambdaAccessPointUI =
  UIProvider.succeed<ObjectLambdaAccessPoint>(
    "AWS.S3Control.ObjectLambdaAccessPoint",
    {
      displayName: "S3 Object Lambda Access Point",
      icon: "zap",
      color: COLOR,
      category: "storage",
      summary: (ctx) => ctx.attrs?.objectLambdaAccessPointName,
      facts: (ctx) => [
        {
          label: "access point",
          value: ctx.attrs?.objectLambdaAccessPointName,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.objectLambdaAccessPointArn,
          mono: true,
          copy: true,
        },
        { label: "alias", value: ctx.attrs?.alias, mono: true },
      ],
    },
  );

export const StorageLensConfigurationUI =
  UIProvider.succeed<StorageLensConfiguration>(
    "AWS.S3Control.StorageLensConfiguration",
    {
      displayName: "S3 Storage Lens Configuration",
      icon: "chart-bar",
      color: COLOR,
      category: "observability",
      summary: (ctx) => ctx.attrs?.configId,
      facts: (ctx) => [
        { label: "configuration", value: ctx.attrs?.configId, copy: true },
        {
          label: "arn",
          value: ctx.attrs?.storageLensArn,
          mono: true,
          copy: true,
        },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    AccessPointUI,
    AccessPointPolicyUI,
    MultiRegionAccessPointUI,
    ObjectLambdaAccessPointUI,
    StorageLensConfigurationUI,
  );
