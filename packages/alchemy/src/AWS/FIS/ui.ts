import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ExperimentTemplate } from "./ExperimentTemplate.ts";
import type { TargetAccountConfiguration } from "./TargetAccountConfiguration.ts";

/**
 * Dashboard UI providers for AWS FIS (Fault Injection Service) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance brand pink. */
const COLOR = "#E7157B";

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const ExperimentTemplateUI = UIProvider.succeed<ExperimentTemplate>(
  "AWS.FIS.ExperimentTemplate",
  {
    displayName: "FIS Experiment Template",
    icon: "test-tube",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.id,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.arn);
      return region === undefined || ctx.attrs?.id === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/fis/home?region=${region}#/experimentTemplates/${ctx.attrs.id}`;
    },
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
    ],
  },
);

export const TargetAccountConfigurationUI =
  UIProvider.succeed<TargetAccountConfiguration>(
    "AWS.FIS.TargetAccountConfiguration",
    {
      displayName: "FIS Target Account Configuration",
      icon: "link",
      color: COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.accountId,
      facts: (ctx) => [
        {
          label: "template",
          value: ctx.attrs?.experimentTemplateId,
          mono: true,
        },
        {
          label: "account",
          value: ctx.attrs?.accountId,
          mono: true,
          copy: true,
        },
        { label: "role", value: ctx.attrs?.roleArn, mono: true },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(ExperimentTemplateUI, TargetAccountConfigurationUI);
