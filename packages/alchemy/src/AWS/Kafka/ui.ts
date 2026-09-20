import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

/**
 * Dashboard UI providers for AWS Kafka resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const ServerlessClusterUI = UIProvider.succeed<ServerlessCluster>(
  "AWS.Kafka.ServerlessCluster",
  {
    displayName: "MSK Serverless Cluster",
    icon: "cable",
    color: "#8C4FFF",
    category: "queue",
    summary: (ctx) => ctx.attrs?.clusterName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.clusterName, copy: true },
      { label: "arn", value: ctx.attrs?.clusterArn, mono: true, copy: true },
      { label: "state", value: ctx.attrs?.state },
      {
        label: "bootstrap brokers",
        value: ctx.attrs?.bootstrapBrokerStringSaslIam,
        mono: true,
        copy: true,
      },
      { label: "subnets", value: ctx.attrs?.subnetIds?.join(", "), mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(ServerlessClusterUI);
