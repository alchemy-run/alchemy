import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { LoadBalancer } from "./LoadBalancer.ts";
import type { Monitor } from "./Monitor.ts";
import type { MonitorGroup } from "./MonitorGroup.ts";
import type { Pool } from "./Pool.ts";

/**
 * Dashboard UI providers for Cloudflare Load Balancing resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no SDK code reaches the dashboard bundle.
 */
export const LoadBalancerUI = UIProvider.succeed<LoadBalancer>(
  "Cloudflare.LoadBalancer.LoadBalancer",
  {
    displayName: "Load Balancer",
    icon: "scale",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    link: (ctx) =>
      ctx.attrs?.name === undefined ? undefined : `https://${ctx.attrs.name}`,
    facts: (ctx) => [
      { label: "hostname", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.loadBalancerId, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "steering", value: ctx.attrs?.steeringPolicy },
      { label: "proxied", value: ctx.attrs?.proxied },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "fallback pool", value: ctx.attrs?.fallbackPool, mono: true },
      { label: "default pools", value: ctx.attrs?.defaultPools?.length },
    ],
  },
);

export const PoolUI = UIProvider.succeed<Pool>("Cloudflare.LoadBalancer.Pool", {
  displayName: "LB Pool",
  icon: "layers",
  color: "#F6821F",
  category: "network",
  summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.poolId, mono: true, copy: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    { label: "enabled", value: ctx.attrs?.enabled },
    { label: "monitor", value: ctx.attrs?.monitor, mono: true },
    { label: "origins", value: ctx.props?.origins?.length },
    { label: "modified", value: ctx.attrs?.modifiedOn },
  ],
});

export const MonitorUI = UIProvider.succeed<Monitor>(
  "Cloudflare.LoadBalancer.Monitor",
  {
    displayName: "LB Monitor",
    icon: "activity",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) => ctx.attrs?.description ?? ctx.props?.description,
    facts: (ctx) => [
      { label: "description", value: ctx.attrs?.description },
      { label: "id", value: ctx.attrs?.monitorId, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "path", value: ctx.props?.path },
      { label: "interval", value: ctx.props?.interval },
      { label: "expected codes", value: ctx.props?.expectedCodes },
    ],
  },
);

export const MonitorGroupUI = UIProvider.succeed<MonitorGroup>(
  "Cloudflare.LoadBalancer.MonitorGroup",
  {
    displayName: "LB Monitor Group",
    icon: "list-checks",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) => ctx.attrs?.description ?? ctx.props?.description,
    facts: (ctx) => [
      { label: "description", value: ctx.attrs?.description },
      {
        label: "id",
        value: ctx.attrs?.monitorGroupId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "members", value: ctx.props?.members?.length },
      { label: "modified", value: ctx.attrs?.modifiedOn },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(LoadBalancerUI, PoolUI, MonitorUI, MonitorGroupUI);
