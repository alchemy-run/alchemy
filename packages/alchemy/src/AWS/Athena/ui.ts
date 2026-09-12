import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DataCatalog } from "./DataCatalog.ts";
import type { NamedQuery } from "./NamedQuery.ts";
import type { PreparedStatement } from "./PreparedStatement.ts";
import type { WorkGroup } from "./WorkGroup.ts";

/**
 * Dashboard UI providers for AWS Athena resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#8C4FFF";

export const DataCatalogUI = UIProvider.succeed<DataCatalog>(
  "AWS.Athena.DataCatalog",
  {
    displayName: "Athena Data Catalog",
    icon: "database",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.dataCatalogArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const NamedQueryUI = UIProvider.succeed<NamedQuery>(
  "AWS.Athena.NamedQuery",
  {
    displayName: "Athena Named Query",
    icon: "scroll-text",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.namedQueryId, mono: true, copy: true },
      { label: "database", value: ctx.attrs?.database, mono: true },
      { label: "work group", value: ctx.attrs?.workGroup },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const PreparedStatementUI = UIProvider.succeed<PreparedStatement>(
  "AWS.Athena.PreparedStatement",
  {
    displayName: "Athena Prepared Statement",
    icon: "file-text",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.statementName,
    facts: (ctx) => [
      { label: "statement", value: ctx.attrs?.statementName, copy: true },
      { label: "work group", value: ctx.attrs?.workGroup },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const WorkGroupUI = UIProvider.succeed<WorkGroup>(
  "AWS.Athena.WorkGroup",
  {
    displayName: "Athena Work Group",
    icon: "layers",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.workGroupName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.workGroupName, copy: true },
      { label: "arn", value: ctx.attrs?.workGroupArn, mono: true, copy: true },
      { label: "state", value: ctx.attrs?.state },
      {
        label: "output location",
        value: ctx.attrs?.outputLocation,
        mono: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(DataCatalogUI, NamedQueryUI, PreparedStatementUI, WorkGroupUI);
