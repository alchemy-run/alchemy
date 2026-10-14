import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Application } from "./Application.ts";

/**
 * Dashboard UI providers for AWS EMRServerless resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const ApplicationUI = UIProvider.succeed<Application>(
  "AWS.EMRServerless.Application",
  {
    displayName: "EMR Serverless Application",
    icon: "cpu",
    color: "#8C4FFF",
    category: "other",
    summary: (ctx) => ctx.attrs?.applicationName,
    facts: (ctx) => [
      {
        label: "application",
        value: ctx.attrs?.applicationName,
        copy: true,
      },
      {
        label: "id",
        value: ctx.attrs?.applicationId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.applicationArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "release label", value: ctx.attrs?.releaseLabel },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const ui = () => Layer.mergeAll(ApplicationUI);
