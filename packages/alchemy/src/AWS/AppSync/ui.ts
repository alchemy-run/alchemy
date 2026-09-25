import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AppSyncApiAssociation } from "./ApiAssociation.ts";
import type { AppSyncApiKey } from "./ApiKey.ts";
import type { AppSyncDataSource } from "./DataSource.ts";
import type { AppSyncDomainName } from "./DomainName.ts";
import type { AppSyncFunction } from "./Function.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";
import type { AppSyncResolver } from "./Resolver.ts";

/**
 * Dashboard UI providers for AWS AppSync resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS App Integration (AppSync) brand pink. */
const COLOR = "#E7157B";

export const GraphqlApiUI = UIProvider.succeed<GraphqlApi>(
  "AWS.AppSync.GraphqlApi",
  {
    displayName: "AppSync GraphQL API",
    icon: "share-2",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.apiId,
    link: (ctx) => ctx.attrs?.graphqlUrl,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "api id", value: ctx.attrs?.apiId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.apiArn, mono: true, copy: true },
      {
        label: "graphql url",
        value: ctx.attrs?.graphqlUrl,
        href: ctx.attrs?.graphqlUrl,
        mono: true,
        copy: true,
      },
      { label: "realtime url", value: ctx.attrs?.realtimeUrl, mono: true },
      { label: "auth", value: ctx.attrs?.authenticationType },
    ],
  },
);

export const ApiKeyUI = UIProvider.succeed<AppSyncApiKey>(
  "AWS.AppSync.ApiKey",
  {
    displayName: "AppSync API Key",
    icon: "key-round",
    color: COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.apiId,
    facts: (ctx) => [
      { label: "api id", value: ctx.attrs?.apiId, mono: true, copy: true },
      { label: "description", value: ctx.attrs?.description },
      { label: "expires", value: ctx.attrs?.expires },
    ],
  },
);

export const DataSourceUI = UIProvider.succeed<AppSyncDataSource>(
  "AWS.AppSync.DataSource",
  {
    displayName: "AppSync Data Source",
    icon: "cable",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "api id", value: ctx.attrs?.apiId, mono: true, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.dataSourceArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "service role", value: ctx.attrs?.serviceRoleArn, mono: true },
    ],
  },
);

export const DomainNameUI = UIProvider.succeed<AppSyncDomainName>(
  "AWS.AppSync.DomainName",
  {
    displayName: "AppSync Domain Name",
    icon: "globe",
    color: COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.domainName,
    link: (ctx) =>
      ctx.attrs?.domainName === undefined
        ? undefined
        : `https://${ctx.attrs.domainName}`,
    facts: (ctx) => [
      {
        label: "domain",
        value: ctx.attrs?.domainName,
        copy: true,
        href:
          ctx.attrs?.domainName === undefined
            ? undefined
            : `https://${ctx.attrs.domainName}`,
      },
      { label: "arn", value: ctx.attrs?.domainNameArn, mono: true, copy: true },
      { label: "certificate", value: ctx.attrs?.certificateArn, mono: true },
      {
        label: "cloudfront target",
        value: ctx.attrs?.appsyncDomainName,
        mono: true,
        copy: true,
      },
      { label: "hosted zone", value: ctx.attrs?.hostedZoneId, mono: true },
    ],
  },
);

export const ApiAssociationUI = UIProvider.succeed<AppSyncApiAssociation>(
  "AWS.AppSync.ApiAssociation",
  {
    displayName: "AppSync API Association",
    icon: "link",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.domainName,
    facts: (ctx) => [
      { label: "domain", value: ctx.attrs?.domainName, mono: true, copy: true },
      { label: "api id", value: ctx.attrs?.apiId, mono: true, copy: true },
    ],
  },
);

export const FunctionUI = UIProvider.succeed<AppSyncFunction>(
  "AWS.AppSync.Function",
  {
    displayName: "AppSync Function",
    icon: "code",
    color: COLOR,
    category: "compute",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "function id",
        value: ctx.attrs?.functionId,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.functionArn, mono: true, copy: true },
      { label: "api id", value: ctx.attrs?.apiId, mono: true, copy: true },
      { label: "data source", value: ctx.attrs?.dataSourceName, mono: true },
    ],
  },
);

export const ResolverUI = UIProvider.succeed<AppSyncResolver>(
  "AWS.AppSync.Resolver",
  {
    displayName: "AppSync Resolver",
    icon: "route",
    color: COLOR,
    category: "compute",
    summary: (ctx) =>
      ctx.attrs?.typeName === undefined || ctx.attrs?.fieldName === undefined
        ? undefined
        : `${ctx.attrs.typeName}.${ctx.attrs.fieldName}`,
    facts: (ctx) => [
      { label: "type", value: ctx.attrs?.typeName, mono: true },
      { label: "field", value: ctx.attrs?.fieldName, mono: true },
      { label: "arn", value: ctx.attrs?.resolverArn, mono: true, copy: true },
      { label: "kind", value: ctx.attrs?.kind },
      { label: "data source", value: ctx.attrs?.dataSourceName, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    GraphqlApiUI,
    ApiKeyUI,
    DataSourceUI,
    DomainNameUI,
    ApiAssociationUI,
    FunctionUI,
    ResolverUI,
  );
