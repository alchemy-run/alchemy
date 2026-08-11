import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ServerlessCache } from "./ServerlessCache.ts";

/**
 * Dashboard UI providers for AWS ElastiCache resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const ServerlessCacheUI = UIProvider.succeed<ServerlessCache>(
  "AWS.ElastiCache.ServerlessCache",
  {
    displayName: "ElastiCache Serverless Cache",
    icon: "database",
    color: "#C925D1",
    category: "database",
    summary: (ctx) => ctx.attrs?.serverlessCacheName,
    facts: (ctx) => [
      {
        label: "cache",
        value: ctx.attrs?.serverlessCacheName,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.serverlessCacheArn,
        mono: true,
        copy: true,
      },
      { label: "engine", value: ctx.attrs?.engine },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "endpoint",
        value: ctx.attrs?.endpointAddress
          ? `${ctx.attrs.endpointAddress}:${ctx.attrs.endpointPort ?? ""}`
          : undefined,
        mono: true,
        copy: true,
      },
      { label: "version", value: ctx.attrs?.fullEngineVersion },
    ],
  },
);

export const ui = () => Layer.mergeAll(ServerlessCacheUI);
