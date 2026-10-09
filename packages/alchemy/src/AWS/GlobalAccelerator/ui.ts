import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Accelerator } from "./Accelerator.ts";
import type { EndpointGroup } from "./EndpointGroup.ts";
import type { Listener } from "./Listener.ts";

/**
 * Dashboard UI providers for AWS GlobalAccelerator resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Networking & Content Delivery brand purple. */
const COLOR = "#8C4FFF";

export const AcceleratorUI = UIProvider.succeed<Accelerator>(
  "AWS.GlobalAccelerator.Accelerator",
  {
    displayName: "Global Accelerator",
    icon: "zap",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.dnsName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.acceleratorArn,
        mono: true,
        copy: true,
      },
      { label: "dns name", value: ctx.attrs?.dnsName, mono: true },
      {
        label: "ip addresses",
        value: ctx.attrs?.ipAddresses?.join(", "),
        mono: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "enabled", value: ctx.attrs?.enabled },
    ],
  },
);

export const EndpointGroupUI = UIProvider.succeed<EndpointGroup>(
  "AWS.GlobalAccelerator.EndpointGroup",
  {
    displayName: "Global Accelerator Endpoint Group",
    icon: "waypoints",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.endpointGroupRegion,
    facts: (ctx) => [
      {
        label: "arn",
        value: ctx.attrs?.endpointGroupArn,
        mono: true,
        copy: true,
      },
      { label: "listener", value: ctx.attrs?.listenerArn, mono: true },
      { label: "region", value: ctx.attrs?.endpointGroupRegion },
      {
        label: "traffic dial %",
        value: ctx.attrs?.trafficDialPercentage,
      },
      { label: "health check", value: ctx.attrs?.healthCheckProtocol },
      { label: "endpoints", value: ctx.attrs?.endpoints?.length },
    ],
  },
);

export const ListenerUI = UIProvider.succeed<Listener>(
  "AWS.GlobalAccelerator.Listener",
  {
    displayName: "Global Accelerator Listener",
    icon: "radio",
    color: COLOR,
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.portRanges?.map((r) => `${r.fromPort}-${r.toPort}`).join(", "),
    facts: (ctx) => [
      { label: "arn", value: ctx.attrs?.listenerArn, mono: true, copy: true },
      { label: "accelerator", value: ctx.attrs?.acceleratorArn, mono: true },
      { label: "protocol", value: ctx.attrs?.protocol },
      {
        label: "port ranges",
        value: ctx.attrs?.portRanges
          ?.map((r) => `${r.fromPort}-${r.toPort}`)
          .join(", "),
        mono: true,
      },
      { label: "client affinity", value: ctx.attrs?.clientAffinity },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(AcceleratorUI, EndpointGroupUI, ListenerUI);
