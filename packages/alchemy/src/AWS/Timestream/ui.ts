import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Database } from "./Database.ts";
import type { DbInstance } from "./DbInstance.ts";
import type { ScheduledQuery } from "./ScheduledQuery.ts";
import type { Table } from "./Table.ts";

/**
 * Dashboard UI providers for AWS Timestream resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Database (Timestream) brand purple. */
const COLOR = "#C925D1";

export const DatabaseUI = UIProvider.succeed<Database>(
  "AWS.Timestream.Database",
  {
    displayName: "Timestream Database",
    icon: "database",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.databaseName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.databaseName, copy: true },
      { label: "arn", value: ctx.attrs?.databaseArn, mono: true, copy: true },
      { label: "kms key", value: ctx.attrs?.kmsKeyId, mono: true },
      { label: "tables", value: ctx.attrs?.tableCount },
    ],
  },
);

export const DbInstanceUI = UIProvider.succeed<DbInstance>(
  "AWS.Timestream.DbInstance",
  {
    displayName: "Timestream InfluxDB Instance",
    icon: "server",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "endpoint",
        value: ctx.attrs?.endpoint,
        mono: true,
        copy: true,
      },
      { label: "instance type", value: ctx.attrs?.dbInstanceType },
    ],
  },
);

export const ScheduledQueryUI = UIProvider.succeed<ScheduledQuery>(
  "AWS.Timestream.ScheduledQuery",
  {
    displayName: "Timestream Scheduled Query",
    icon: "clock",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.scheduledQueryArn,
        mono: true,
        copy: true,
      },
      { label: "state", value: ctx.attrs?.state },
      { label: "schedule", value: ctx.props?.scheduleExpression, mono: true },
    ],
  },
);

export const TableUI = UIProvider.succeed<Table>("AWS.Timestream.Table", {
  displayName: "Timestream Table",
  icon: "table",
  color: COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.tableName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.tableName, copy: true },
    {
      label: "database",
      value: ctx.attrs?.databaseName,
      mono: true,
      copy: true,
    },
    { label: "arn", value: ctx.attrs?.tableArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.tableStatus },
  ],
});

export const ui = () =>
  Layer.mergeAll(DatabaseUI, DbInstanceUI, ScheduledQueryUI, TableUI);
