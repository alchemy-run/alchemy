import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Environment } from "./Environment.ts";
import type { KxCluster } from "./KxCluster.ts";
import type { KxDatabase } from "./KxDatabase.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Dashboard UI providers for AWS FinSpace resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Database brand purple. */
const COLOR = "#C925D1";

export const EnvironmentUI = UIProvider.succeed<Environment>(
  "AWS.FinSpace.Environment",
  {
    displayName: "FinSpace Environment",
    icon: "building-2",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    link: (ctx) => ctx.attrs?.environmentUrl,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.environmentId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.environmentArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "url",
        value: ctx.attrs?.environmentUrl,
        href: ctx.attrs?.environmentUrl,
      },
    ],
  },
);

export const KxClusterUI = UIProvider.succeed<KxCluster>(
  "AWS.FinSpace.KxCluster",
  {
    displayName: "FinSpace kdb Cluster",
    icon: "server",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.clusterName,
    facts: (ctx) => [
      { label: "cluster", value: ctx.attrs?.clusterName, copy: true },
      { label: "environment", value: ctx.attrs?.environmentId, mono: true },
      { label: "type", value: ctx.attrs?.clusterType },
      { label: "status", value: ctx.attrs?.status },
      { label: "release", value: ctx.attrs?.releaseLabel },
      { label: "az mode", value: ctx.attrs?.azMode },
    ],
  },
);

export const KxDatabaseUI = UIProvider.succeed<KxDatabase>(
  "AWS.FinSpace.KxDatabase",
  {
    displayName: "FinSpace kdb Database",
    icon: "database",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.databaseName,
    facts: (ctx) => [
      { label: "database", value: ctx.attrs?.databaseName, copy: true },
      { label: "environment", value: ctx.attrs?.environmentId, mono: true },
      {
        label: "arn",
        value: ctx.attrs?.databaseArn,
        mono: true,
        copy: true,
      },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const KxEnvironmentUI = UIProvider.succeed<KxEnvironment>(
  "AWS.FinSpace.KxEnvironment",
  {
    displayName: "FinSpace kdb Environment",
    icon: "boxes",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.environmentId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.environmentArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "kms key", value: ctx.attrs?.kmsKeyId, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(EnvironmentUI, KxClusterUI, KxDatabaseUI, KxEnvironmentUI);
