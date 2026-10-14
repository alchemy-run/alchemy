import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Parameter } from "./Parameter.ts";

/**
 * Dashboard UI providers for AWS SSM resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const ParameterUI = UIProvider.succeed<Parameter>("AWS.SSM.Parameter", {
  displayName: "SSM Parameter",
  icon: "settings",
  color: "#E7157B",
  category: "config",
  summary: (ctx) => ctx.attrs?.parameterName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.parameterArn);
    return ctx.attrs?.parameterName === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/systems-manager/parameters${encodeURIComponent(ctx.attrs.parameterName)}/description?region=${region}`;
  },
  facts: (ctx) => [
    { label: "parameter", value: ctx.attrs?.parameterName, copy: true },
    { label: "arn", value: ctx.attrs?.parameterArn, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "version", value: ctx.attrs?.version },
    { label: "kms key", value: ctx.attrs?.keyArn, mono: true },
  ],
});

export const ui = () => Layer.mergeAll(ParameterUI);
