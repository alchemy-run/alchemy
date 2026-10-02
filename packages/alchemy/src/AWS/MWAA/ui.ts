import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Environment } from "./Environment.ts";

/**
 * Dashboard UI providers for AWS MWAA resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const EnvironmentUI = UIProvider.succeed<Environment>(
  "AWS.MWAA.Environment",
  {
    displayName: "MWAA Environment",
    icon: "workflow",
    color: "#8C4FFF",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.environmentName,
    link: (ctx) =>
      ctx.attrs?.webserverUrl === undefined
        ? undefined
        : `https://${ctx.attrs.webserverUrl}`,
    facts: (ctx) => [
      { label: "environment", value: ctx.attrs?.environmentName, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "airflow version", value: ctx.attrs?.airflowVersion },
      { label: "class", value: ctx.attrs?.environmentClass },
      {
        label: "webserver",
        value: ctx.attrs?.webserverUrl,
        href:
          ctx.attrs?.webserverUrl === undefined
            ? undefined
            : `https://${ctx.attrs.webserverUrl}`,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(EnvironmentUI);
