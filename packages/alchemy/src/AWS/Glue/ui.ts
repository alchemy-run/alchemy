import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Connection } from "./Connection.ts";
import type { Crawler } from "./Crawler.ts";
import type { Database } from "./Database.ts";
import type { Job } from "./Job.ts";
import type { Table } from "./Table.ts";

/**
 * Dashboard UI providers for AWS Glue resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Analytics (Glue) brand purple. */
const COLOR = "#8C4FFF";

export const ConnectionUI = UIProvider.succeed<Connection>(
  "AWS.Glue.Connection",
  {
    displayName: "Glue Connection",
    icon: "plug",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.connectionName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.connectionName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.connectionArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.connectionType },
      { label: "catalog id", value: ctx.attrs?.catalogId, mono: true },
    ],
  },
);

export const CrawlerUI = UIProvider.succeed<Crawler>("AWS.Glue.Crawler", {
  displayName: "Glue Crawler",
  icon: "search",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.crawlerName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.crawlerName, copy: true },
    { label: "arn", value: ctx.attrs?.crawlerArn, mono: true, copy: true },
    { label: "state", value: ctx.attrs?.state },
    { label: "database", value: ctx.attrs?.databaseName, mono: true },
    { label: "role", value: ctx.attrs?.role, mono: true },
  ],
});

export const DatabaseUI = UIProvider.succeed<Database>("AWS.Glue.Database", {
  displayName: "Glue Database",
  icon: "database",
  color: COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.databaseName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.databaseName, copy: true },
    { label: "arn", value: ctx.attrs?.databaseArn, mono: true, copy: true },
    { label: "catalog id", value: ctx.attrs?.catalogId, mono: true },
    { label: "location", value: ctx.props?.locationUri, mono: true },
  ],
});

export const JobUI = UIProvider.succeed<Job>("AWS.Glue.Job", {
  displayName: "Glue Job",
  icon: "play",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.jobName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.jobName, copy: true },
    { label: "arn", value: ctx.attrs?.jobArn, mono: true, copy: true },
    { label: "role", value: ctx.attrs?.role, mono: true },
    { label: "command", value: ctx.props?.command?.name },
    { label: "glue version", value: ctx.props?.glueVersion },
  ],
});

export const TableUI = UIProvider.succeed<Table>("AWS.Glue.Table", {
  displayName: "Glue Table",
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
    { label: "catalog id", value: ctx.attrs?.catalogId, mono: true },
    {
      label: "location",
      value: ctx.props?.storageDescriptor?.location,
      mono: true,
    },
  ],
});

export const ui = () =>
  Layer.mergeAll(ConnectionUI, CrawlerUI, DatabaseUI, JobUI, TableUI);
