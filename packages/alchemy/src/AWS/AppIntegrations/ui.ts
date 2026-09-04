import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Application } from "./Application.ts";
import type { DataIntegration } from "./DataIntegration.ts";
import type { EventIntegration } from "./EventIntegration.ts";

/**
 * Dashboard UI providers for AWS AppIntegrations resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#E7157B";

export const ApplicationUI = UIProvider.succeed<Application>(
  "AWS.AppIntegrations.Application",
  {
    displayName: "AppIntegrations Application",
    icon: "app-window",
    color: COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.applicationName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.applicationName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.applicationArn,
        mono: true,
        copy: true,
      },
      { label: "namespace", value: ctx.attrs?.namespace, mono: true },
      { label: "access url", value: ctx.props?.accessUrl, mono: true },
    ],
  },
);

export const DataIntegrationUI = UIProvider.succeed<DataIntegration>(
  "AWS.AppIntegrations.DataIntegration",
  {
    displayName: "AppIntegrations Data Integration",
    icon: "download",
    color: COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.dataIntegrationName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.dataIntegrationName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.dataIntegrationArn,
        mono: true,
        copy: true,
      },
      { label: "source uri", value: ctx.attrs?.sourceURI, mono: true },
      { label: "kms key", value: ctx.attrs?.kmsKey, mono: true },
    ],
  },
);

export const EventIntegrationUI = UIProvider.succeed<EventIntegration>(
  "AWS.AppIntegrations.EventIntegration",
  {
    displayName: "AppIntegrations Event Integration",
    icon: "webhook",
    color: COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.eventIntegrationName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.eventIntegrationName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.eventIntegrationArn,
        mono: true,
        copy: true,
      },
      { label: "source", value: ctx.attrs?.source, mono: true },
      { label: "event bus", value: ctx.attrs?.eventBridgeBus },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ApplicationUI, DataIntegrationUI, EventIntegrationUI);
