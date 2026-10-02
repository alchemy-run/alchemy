import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ComponentVersion } from "./ComponentVersion.ts";
import type { Deployment } from "./Deployment.ts";

/**
 * Dashboard UI providers for AWS GreengrassV2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance brand pink. */
const COLOR = "#E7157B";

export const ComponentVersionUI = UIProvider.succeed<ComponentVersion>(
  "AWS.GreengrassV2.ComponentVersion",
  {
    displayName: "Greengrass Component Version",
    icon: "package",
    color: COLOR,
    category: "config",
    summary: (ctx) =>
      ctx.attrs?.componentName === undefined
        ? undefined
        : `${ctx.attrs.componentName}@${ctx.attrs.componentVersion ?? ""}`,
    facts: (ctx) => [
      { label: "component", value: ctx.attrs?.componentName, copy: true },
      { label: "version", value: ctx.attrs?.componentVersion },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
    ],
  },
);

export const DeploymentUI = UIProvider.succeed<Deployment>(
  "AWS.GreengrassV2.Deployment",
  {
    displayName: "Greengrass Deployment",
    icon: "upload",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.props?.deploymentName ?? ctx.attrs?.deploymentId,
    facts: (ctx) => [
      {
        label: "deployment id",
        value: ctx.attrs?.deploymentId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.deploymentArn,
        mono: true,
        copy: true,
      },
      { label: "target", value: ctx.attrs?.targetArn, mono: true },
      { label: "status", value: ctx.attrs?.deploymentStatus },
      { label: "revision", value: ctx.attrs?.revisionId },
      { label: "iot job", value: ctx.attrs?.iotJobId, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(ComponentVersionUI, DeploymentUI);
