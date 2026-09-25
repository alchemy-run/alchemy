import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DataCellsFilter } from "./DataCellsFilter.ts";
import type { DataLakeSettings } from "./DataLakeSettings.ts";
import type { LFTag } from "./LFTag.ts";
import type { LFTagAssociation } from "./LFTagAssociation.ts";
import type { LFTagExpression } from "./LFTagExpression.ts";
import type { OptIn } from "./OptIn.ts";
import type { Permissions } from "./Permissions.ts";

/**
 * Dashboard UI providers for AWS LakeFormation resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS analytics brand purple (Lake Formation). */
const COLOR = "#8C4FFF";

/** A Lake Formation resource union's best single-line label. */
const resourceLabel = (
  resource:
    | {
        Database?: { Name?: string };
        Table?: { Name?: string };
        TableWithColumns?: { Name?: string };
        DataLocation?: { ResourceArn?: string };
        LFTag?: { TagKey?: string };
        LFTagPolicy?: { ResourceType?: string };
        Catalog?: { Id?: string };
      }
    | undefined,
): string | undefined =>
  resource?.Database?.Name ??
  resource?.Table?.Name ??
  resource?.TableWithColumns?.Name ??
  resource?.DataLocation?.ResourceArn ??
  resource?.LFTag?.TagKey ??
  resource?.LFTagPolicy?.ResourceType ??
  resource?.Catalog?.Id;

export const DataCellsFilterUI = UIProvider.succeed<DataCellsFilter>(
  "AWS.LakeFormation.DataCellsFilter",
  {
    displayName: "Data Cells Filter",
    icon: "filter",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "database", value: ctx.attrs?.databaseName, mono: true },
      { label: "table", value: ctx.attrs?.tableName, mono: true },
      { label: "catalog id", value: ctx.attrs?.tableCatalogId, mono: true },
      { label: "version", value: ctx.attrs?.versionId, mono: true },
    ],
  },
);

export const DataLakeSettingsUI = UIProvider.succeed<DataLakeSettings>(
  "AWS.LakeFormation.DataLakeSettings",
  {
    displayName: "Data Lake Settings",
    icon: "settings",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.catalogId,
    facts: (ctx) => [
      {
        label: "catalog id",
        value: ctx.attrs?.catalogId,
        mono: true,
        copy: true,
      },
      {
        label: "admins",
        value: ctx.attrs?.dataLakeAdmins?.join(", "),
        mono: true,
      },
      {
        label: "read-only admins",
        value: ctx.attrs?.readOnlyAdmins?.join(", "),
        mono: true,
      },
      { label: "managed fields", value: ctx.attrs?.managedFields?.join(", ") },
    ],
  },
);

export const LFTagUI = UIProvider.succeed<LFTag>("AWS.LakeFormation.LFTag", {
  displayName: "LF-Tag",
  icon: "tag",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.tagKey,
  facts: (ctx) => [
    { label: "key", value: ctx.attrs?.tagKey, copy: true },
    { label: "values", value: ctx.attrs?.tagValues?.join(", ") },
    { label: "catalog id", value: ctx.attrs?.catalogId, mono: true },
  ],
});

export const LFTagAssociationUI = UIProvider.succeed<LFTagAssociation>(
  "AWS.LakeFormation.LFTagAssociation",
  {
    displayName: "LF-Tag Association",
    icon: "tags",
    color: COLOR,
    category: "other",
    summary: (ctx) => resourceLabel(ctx.attrs?.resource),
    facts: (ctx) => [
      {
        label: "resource",
        value: resourceLabel(ctx.attrs?.resource),
        mono: true,
        copy: true,
      },
      {
        label: "tags",
        value: ctx.attrs?.lfTags
          ?.map((t) => `${t.tagKey}=${t.tagValues.join("/")}`)
          .join(", "),
      },
      { label: "catalog id", value: ctx.attrs?.catalogId, mono: true },
    ],
  },
);

export const LFTagExpressionUI = UIProvider.succeed<LFTagExpression>(
  "AWS.LakeFormation.LFTagExpression",
  {
    displayName: "LF-Tag Expression",
    icon: "scroll-text",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "description", value: ctx.attrs?.description },
      {
        label: "expression",
        value: ctx.attrs?.expression
          ?.map((e) => `${e.tagKey}=${e.tagValues.join("/")}`)
          .join(", "),
      },
      { label: "catalog id", value: ctx.attrs?.catalogId, mono: true },
    ],
  },
);

export const OptInUI = UIProvider.succeed<OptIn>("AWS.LakeFormation.OptIn", {
  displayName: "Lake Formation Opt-In",
  icon: "shield-check",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.principal,
  facts: (ctx) => [
    { label: "principal", value: ctx.attrs?.principal, mono: true, copy: true },
    {
      label: "resource",
      value: resourceLabel(ctx.attrs?.resource),
      mono: true,
    },
  ],
});

export const PermissionsUI = UIProvider.succeed<Permissions>(
  "AWS.LakeFormation.Permissions",
  {
    displayName: "Lake Formation Permissions",
    icon: "key-round",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.principal,
    facts: (ctx) => [
      {
        label: "principal",
        value: ctx.attrs?.principal,
        mono: true,
        copy: true,
      },
      {
        label: "resource",
        value: resourceLabel(ctx.attrs?.resource),
        mono: true,
      },
      { label: "permissions", value: ctx.attrs?.permissions?.join(", ") },
      {
        label: "grant option",
        value: ctx.attrs?.permissionsWithGrantOption?.join(", "),
      },
      { label: "catalog id", value: ctx.attrs?.catalogId, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    DataCellsFilterUI,
    DataLakeSettingsUI,
    LFTagUI,
    LFTagAssociationUI,
    LFTagExpressionUI,
    OptInUI,
    PermissionsUI,
  );
