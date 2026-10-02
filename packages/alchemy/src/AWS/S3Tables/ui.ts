import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Namespace } from "./Namespace.ts";
import type { Table } from "./Table.ts";
import type { TableBucket } from "./TableBucket.ts";

/**
 * Dashboard UI providers for AWS S3Tables resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Storage (S3 Tables) brand green. */
const COLOR = "#7AA116";

export const TableBucketUI = UIProvider.succeed<TableBucket>(
  "AWS.S3Tables.TableBucket",
  {
    displayName: "S3 Table Bucket",
    icon: "cylinder",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.tableBucketArn,
        mono: true,
        copy: true,
      },
      { label: "owner", value: ctx.attrs?.ownerAccountId, mono: true },
      { label: "type", value: ctx.attrs?.type },
    ],
  },
);

export const NamespaceUI = UIProvider.succeed<Namespace>(
  "AWS.S3Tables.Namespace",
  {
    displayName: "S3 Tables Namespace",
    icon: "folder",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.namespace,
    facts: (ctx) => [
      { label: "namespace", value: ctx.attrs?.namespace, copy: true },
      {
        label: "table bucket",
        value: ctx.attrs?.tableBucketArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.namespaceId, mono: true },
      { label: "owner", value: ctx.attrs?.ownerAccountId, mono: true },
    ],
  },
);

export const TableUI = UIProvider.succeed<Table>("AWS.S3Tables.Table", {
  displayName: "S3 Tables Table",
  icon: "table",
  color: COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "namespace", value: ctx.attrs?.namespace, mono: true },
    { label: "arn", value: ctx.attrs?.tableArn, mono: true, copy: true },
    { label: "format", value: ctx.attrs?.format },
    { label: "type", value: ctx.attrs?.type },
    {
      label: "warehouse location",
      value: ctx.attrs?.warehouseLocation,
      mono: true,
    },
  ],
});

export const ui = () => Layer.mergeAll(TableBucketUI, NamespaceUI, TableUI);
