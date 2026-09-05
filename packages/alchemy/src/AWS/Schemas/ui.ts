import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Discoverer } from "./Discoverer.ts";
import type { Registry } from "./Registry.ts";
import type { Schema } from "./Schema.ts";

/**
 * Dashboard UI providers for AWS Schemas resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const SCHEMAS_COLOR = "#E7157B";

export const DiscovererUI = UIProvider.succeed<Discoverer>(
  "AWS.Schemas.Discoverer",
  {
    displayName: "Schemas Discoverer",
    icon: "search",
    color: SCHEMAS_COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.discovererId,
    facts: (ctx) => [
      {
        label: "discoverer",
        value: ctx.attrs?.discovererId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.discovererArn,
        mono: true,
        copy: true,
      },
      { label: "source", value: ctx.attrs?.sourceArn, mono: true },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const RegistryUI = UIProvider.succeed<Registry>("AWS.Schemas.Registry", {
  displayName: "Schemas Registry",
  icon: "book-open",
  color: SCHEMAS_COLOR,
  category: "eventing",
  summary: (ctx) => ctx.attrs?.registryName,
  facts: (ctx) => [
    { label: "registry", value: ctx.attrs?.registryName, copy: true },
    { label: "arn", value: ctx.attrs?.registryArn, mono: true, copy: true },
    { label: "description", value: ctx.props?.description },
  ],
});

export const SchemaUI = UIProvider.succeed<Schema>("AWS.Schemas.Schema", {
  displayName: "Schemas Schema",
  icon: "file-text",
  color: SCHEMAS_COLOR,
  category: "eventing",
  summary: (ctx) => ctx.attrs?.schemaName,
  facts: (ctx) => [
    { label: "schema", value: ctx.attrs?.schemaName, copy: true },
    { label: "arn", value: ctx.attrs?.schemaArn, mono: true, copy: true },
    { label: "registry", value: ctx.attrs?.registryName, mono: true },
    { label: "version", value: ctx.attrs?.schemaVersion },
    { label: "type", value: ctx.attrs?.type },
  ],
});

export const ui = () => Layer.mergeAll(DiscovererUI, RegistryUI, SchemaUI);
