import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Cluster } from "./Cluster.ts";
import type { Hsm } from "./Hsm.ts";

/**
 * Dashboard UI providers for AWS CloudHSMV2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Security, Identity & Compliance brand red. */
const COLOR = "#DD344C";

export const ClusterUI = UIProvider.succeed<Cluster>("AWS.CloudHSMV2.Cluster", {
  displayName: "CloudHSM Cluster",
  icon: "shield-check",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.clusterId,
  facts: (ctx) => [
    {
      label: "cluster id",
      value: ctx.attrs?.clusterId,
      mono: true,
      copy: true,
    },
    { label: "state", value: ctx.attrs?.state },
    { label: "hsm type", value: ctx.attrs?.hsmType },
    { label: "mode", value: ctx.attrs?.mode },
    { label: "network type", value: ctx.attrs?.networkType },
    { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
    { label: "backup retention (days)", value: ctx.attrs?.backupRetentionDays },
  ],
});

export const HsmUI = UIProvider.succeed<Hsm>("AWS.CloudHSMV2.Hsm", {
  displayName: "CloudHSM HSM",
  icon: "cpu",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.hsmId,
  facts: (ctx) => [
    { label: "hsm id", value: ctx.attrs?.hsmId, mono: true, copy: true },
    { label: "cluster", value: ctx.attrs?.clusterId, mono: true, copy: true },
    { label: "state", value: ctx.attrs?.state },
    { label: "az", value: ctx.attrs?.availabilityZone },
    { label: "eni", value: ctx.attrs?.eniId, mono: true },
    { label: "eni ip", value: ctx.attrs?.eniIp, mono: true },
  ],
});

export const ui = () => Layer.mergeAll(ClusterUI, HsmUI);
