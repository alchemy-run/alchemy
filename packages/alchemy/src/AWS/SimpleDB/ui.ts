import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Domain } from "./Domain.ts";

/**
 * Dashboard UI providers for AWS SimpleDB resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const DomainUI = UIProvider.succeed<Domain>("AWS.SimpleDB.Domain", {
  displayName: "SimpleDB Domain",
  icon: "table",
  color: "#C925D1",
  category: "database",
  summary: (ctx) => ctx.attrs?.domainName,
  facts: (ctx) => [
    { label: "domain", value: ctx.attrs?.domainName, copy: true },
    { label: "arn", value: ctx.attrs?.domainArn, mono: true, copy: true },
  ],
});

export const ui = () => Layer.mergeAll(DomainUI);
