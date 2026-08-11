import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Keyspace } from "./Keyspace.ts";
import type { Table } from "./Table.ts";
import type { Type } from "./Type.ts";

/**
 * Dashboard UI providers for AWS Keyspaces (for Apache Cassandra) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#C925D1";

export const KeyspaceUI = UIProvider.succeed<Keyspace>(
  "AWS.Keyspaces.Keyspace",
  {
    displayName: "Keyspaces Keyspace",
    icon: "database",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.keyspaceName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.keyspaceName, copy: true },
      { label: "arn", value: ctx.attrs?.keyspaceArn, mono: true, copy: true },
      { label: "replication", value: ctx.attrs?.replicationStrategy },
    ],
  },
);

export const TableUI = UIProvider.succeed<Table>("AWS.Keyspaces.Table", {
  displayName: "Keyspaces Table",
  icon: "table",
  color: COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.tableName,
  facts: (ctx) => [
    { label: "table", value: ctx.attrs?.tableName, copy: true },
    { label: "keyspace", value: ctx.attrs?.keyspaceName, mono: true },
    { label: "arn", value: ctx.attrs?.tableArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "stream arn", value: ctx.attrs?.latestStreamArn, mono: true },
  ],
});

export const TypeUI = UIProvider.succeed<Type>("AWS.Keyspaces.Type", {
  displayName: "Keyspaces Type",
  icon: "layers",
  color: COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.typeName,
  facts: (ctx) => [
    { label: "type", value: ctx.attrs?.typeName, copy: true },
    { label: "keyspace", value: ctx.attrs?.keyspaceName, mono: true },
    { label: "keyspace arn", value: ctx.attrs?.keyspaceArn, mono: true },
  ],
});

export const ui = () => Layer.mergeAll(KeyspaceUI, TableUI, TypeUI);
