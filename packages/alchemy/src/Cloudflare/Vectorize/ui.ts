import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Index } from "./VectorizeIndex.ts";
import type { MetadataIndex } from "./VectorizeMetadataIndex.ts";

/**
 * Dashboard UI providers for Cloudflare Vectorize resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const IndexUI = UIProvider.succeed<Index>("Cloudflare.VectorizeIndex", {
  displayName: "Vectorize Index",
  icon: "box",
  color: "#F6821F",
  category: "ai",
  summary: (ctx) => ctx.attrs?.indexName,
  facts: (ctx) => [
    { label: "index", value: ctx.attrs?.indexName, mono: true, copy: true },
    { label: "dimensions", value: ctx.attrs?.dimensions },
    { label: "metric", value: ctx.attrs?.metric },
    { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    { label: "description", value: ctx.attrs?.description },
    { label: "created", value: ctx.attrs?.createdOn },
  ],
});

export const MetadataIndexUI = UIProvider.succeed<MetadataIndex>(
  "Cloudflare.VectorizeMetadataIndex",
  {
    displayName: "Vectorize Metadata Index",
    icon: "tags",
    color: "#F6821F",
    category: "ai",
    summary: (ctx) =>
      ctx.attrs?.propertyName === undefined
        ? undefined
        : `${ctx.attrs.propertyName} (${ctx.attrs.indexType ?? "?"})`,
    facts: (ctx) => [
      { label: "property", value: ctx.attrs?.propertyName, copy: true },
      { label: "type", value: ctx.attrs?.indexType },
      { label: "index", value: ctx.attrs?.indexName, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(IndexUI, MetadataIndexUI);
