import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { InvestigationGroup } from "./InvestigationGroup.ts";

/**
 * Dashboard UI providers for AWS AIOps resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const InvestigationGroupUI = UIProvider.succeed<InvestigationGroup>(
  "AWS.AIOps.InvestigationGroup",
  {
    displayName: "CloudWatch Investigation Group",
    icon: "search",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "role", value: ctx.attrs?.roleArn, mono: true, copy: true },
      { label: "retention (days)", value: ctx.attrs?.retentionInDays },
    ],
  },
);

export const ui = () => Layer.mergeAll(InvestigationGroupUI);
