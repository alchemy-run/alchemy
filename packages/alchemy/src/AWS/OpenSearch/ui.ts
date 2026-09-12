import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Domain } from "./Domain.ts";

/**
 * Dashboard UI providers for AWS OpenSearch resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Analytics (OpenSearch) brand purple. */
const COLOR = "#8C4FFF";

export const DomainUI = UIProvider.succeed<Domain>("AWS.OpenSearch.Domain", {
  displayName: "OpenSearch Domain",
  icon: "search",
  color: COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.domainName,
  link: (ctx) =>
    ctx.attrs?.endpoint === undefined
      ? undefined
      : `https://${ctx.attrs.endpoint}`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.domainName, copy: true },
    { label: "arn", value: ctx.attrs?.domainArn, mono: true, copy: true },
    { label: "id", value: ctx.attrs?.domainId, mono: true },
    {
      label: "endpoint",
      value: ctx.attrs?.endpoint,
      href:
        ctx.attrs?.endpoint === undefined
          ? undefined
          : `https://${ctx.attrs.endpoint}`,
      mono: true,
      copy: true,
    },
    { label: "engine version", value: ctx.attrs?.engineVersion },
    { label: "processing", value: ctx.attrs?.processing },
  ],
});

export const ui = () => Layer.mergeAll(DomainUI);
