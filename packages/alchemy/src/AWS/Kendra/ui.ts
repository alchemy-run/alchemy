import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DataSource } from "./DataSource.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * Dashboard UI providers for AWS Kendra resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const KENDRA_COLOR = "#01A88D";

export const DataSourceUI = UIProvider.succeed<DataSource>(
  "AWS.Kendra.DataSource",
  {
    displayName: "Kendra Data Source",
    icon: "plug",
    color: KENDRA_COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "source", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true },
      { label: "index", value: ctx.attrs?.indexId, mono: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const IndexUI = UIProvider.succeed<Index>("AWS.Kendra.Index", {
  displayName: "Kendra Index",
  icon: "search",
  color: KENDRA_COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "index", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.id, mono: true },
    { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
    { label: "edition", value: ctx.attrs?.edition },
    { label: "status", value: ctx.attrs?.status },
    { label: "role", value: ctx.attrs?.roleArn, mono: true },
  ],
});

export const ui = () => Layer.mergeAll(DataSourceUI, IndexUI);
