import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ConnectorProfile } from "./ConnectorProfile.ts";
import type { Flow } from "./Flow.ts";

/**
 * Dashboard UI providers for AWS AppFlow resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const ConnectorProfileUI = UIProvider.succeed<ConnectorProfile>(
  "AWS.AppFlow.ConnectorProfile",
  {
    displayName: "AppFlow Connector Profile",
    icon: "plug",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.connectorProfileName,
    facts: (ctx) => [
      {
        label: "profile",
        value: ctx.attrs?.connectorProfileName,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.connectorProfileArn,
        mono: true,
        copy: true,
      },
      { label: "connector type", value: ctx.attrs?.connectorType },
      {
        label: "credentials arn",
        value: ctx.attrs?.credentialsArn,
        mono: true,
      },
    ],
  },
);

export const FlowUI = UIProvider.succeed<Flow>("AWS.AppFlow.Flow", {
  displayName: "AppFlow Flow",
  icon: "workflow",
  color: "#E7157B",
  category: "eventing",
  summary: (ctx) => ctx.attrs?.flowName,
  facts: (ctx) => [
    { label: "flow", value: ctx.attrs?.flowName, copy: true },
    { label: "arn", value: ctx.attrs?.flowArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.flowStatus },
  ],
});

export const ui = () => Layer.mergeAll(ConnectorProfileUI, FlowUI);
