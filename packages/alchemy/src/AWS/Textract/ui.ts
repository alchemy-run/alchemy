import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Adapter } from "./Adapter.ts";

/**
 * Dashboard UI providers for AWS Textract resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const AdapterUI = UIProvider.succeed<Adapter>("AWS.Textract.Adapter", {
  displayName: "Textract Adapter",
  icon: "file-text",
  color: "#01A88D",
  category: "ai",
  summary: (ctx) => ctx.attrs?.adapterName,
  facts: (ctx) => [
    { label: "adapter", value: ctx.attrs?.adapterName, copy: true },
    { label: "id", value: ctx.attrs?.adapterId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.adapterArn, mono: true, copy: true },
    {
      label: "feature types",
      value: ctx.attrs?.featureTypes?.length
        ? ctx.attrs.featureTypes.join(", ")
        : undefined,
    },
    { label: "auto update", value: ctx.attrs?.autoUpdate },
  ],
});

export const ui = () => Layer.mergeAll(AdapterUI);
