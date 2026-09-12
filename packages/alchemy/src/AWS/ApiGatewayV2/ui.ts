import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Api } from "./Api.ts";
import type { ApiMapping } from "./ApiMapping.ts";
import type { AuthorizerType } from "./Authorizer.ts";
import type { DomainName } from "./DomainName.ts";
import type { IntegrationType } from "./Integration.ts";
import type { RouteType } from "./Route.ts";
import type { ApiGatewayV2Stage } from "./Stage.ts";
import type { VpcLink } from "./VpcLink.ts";

/**
 * Dashboard UI providers for AWS ApiGatewayV2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS App Integration (API Gateway) brand pink. */
const COLOR = "#E7157B";

export const ApiUI = UIProvider.succeed<Api>("AWS.ApiGatewayV2.Api", {
  displayName: "API Gateway V2 API",
  icon: "network",
  color: COLOR,
  category: "network",
  summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.apiId,
  link: (ctx) => ctx.attrs?.apiEndpoint,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "api id", value: ctx.attrs?.apiId, mono: true, copy: true },
    {
      label: "endpoint",
      value: ctx.attrs?.apiEndpoint,
      mono: true,
      href: ctx.attrs?.apiEndpoint,
      copy: true,
    },
    { label: "protocol", value: ctx.attrs?.protocolType },
    { label: "description", value: ctx.attrs?.description },
  ],
});

export const ApiMappingUI = UIProvider.succeed<ApiMapping>(
  "AWS.ApiGatewayV2.ApiMapping",
  {
    displayName: "API Gateway V2 API Mapping",
    icon: "link",
    color: COLOR,
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.domainName === undefined
        ? undefined
        : `${ctx.attrs.domainName}/${ctx.attrs.apiMappingKey ?? ""}`,
    facts: (ctx) => [
      { label: "domain", value: ctx.attrs?.domainName, copy: true },
      {
        label: "mapping id",
        value: ctx.attrs?.apiMappingId,
        mono: true,
        copy: true,
      },
      { label: "api id", value: ctx.attrs?.apiId, mono: true, copy: true },
      { label: "stage", value: ctx.attrs?.stage, mono: true },
      { label: "base path", value: ctx.attrs?.apiMappingKey, mono: true },
    ],
  },
);

export const AuthorizerUI = UIProvider.succeed<AuthorizerType>(
  "AWS.ApiGatewayV2.Authorizer",
  {
    displayName: "API Gateway V2 Authorizer",
    icon: "shield-check",
    color: COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "authorizer id",
        value: ctx.attrs?.authorizerId,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.authorizerType },
      { label: "api id", value: ctx.attrs?.apiId, mono: true, copy: true },
      { label: "issuer", value: ctx.attrs?.jwtConfiguration?.Issuer },
    ],
  },
);

export const DomainNameUI = UIProvider.succeed<DomainName>(
  "AWS.ApiGatewayV2.DomainName",
  {
    displayName: "API Gateway V2 Domain Name",
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
      {
        label: "target domain",
        value: ctx.attrs?.domainNameConfigurations?.[0]?.ApiGatewayDomainName,
        mono: true,
        copy: true,
      },
      {
        label: "hosted zone",
        value: ctx.attrs?.domainNameConfigurations?.[0]?.HostedZoneId,
        mono: true,
      },
    ],
  },
);

export const IntegrationUI = UIProvider.succeed<IntegrationType>(
  "AWS.ApiGatewayV2.Integration",
  {
    displayName: "API Gateway V2 Integration",
    icon: "plug",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.integrationUri ?? ctx.attrs?.integrationType,
    facts: (ctx) => [
      { label: "type", value: ctx.attrs?.integrationType },
      { label: "uri", value: ctx.attrs?.integrationUri, mono: true },
      {
        label: "integration id",
        value: ctx.attrs?.integrationId,
        mono: true,
        copy: true,
      },
      { label: "api id", value: ctx.attrs?.apiId, mono: true, copy: true },
      { label: "method", value: ctx.attrs?.integrationMethod, mono: true },
      { label: "payload version", value: ctx.attrs?.payloadFormatVersion },
    ],
  },
);

export const RouteUI = UIProvider.succeed<RouteType>("AWS.ApiGatewayV2.Route", {
  displayName: "API Gateway V2 Route",
  icon: "route",
  color: COLOR,
  category: "network",
  summary: (ctx) => ctx.attrs?.routeKey,
  facts: (ctx) => [
    { label: "route key", value: ctx.attrs?.routeKey, mono: true },
    { label: "route id", value: ctx.attrs?.routeId, mono: true, copy: true },
    { label: "api id", value: ctx.attrs?.apiId, mono: true, copy: true },
    { label: "target", value: ctx.attrs?.target, mono: true },
    { label: "authorization", value: ctx.attrs?.authorizationType },
    { label: "authorizer id", value: ctx.attrs?.authorizerId, mono: true },
  ],
});

export const StageUI = UIProvider.succeed<ApiGatewayV2Stage>(
  "AWS.ApiGatewayV2.Stage",
  {
    displayName: "API Gateway V2 Stage",
    icon: "layers",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.stageName,
    link: (ctx) => ctx.attrs?.invokeUrl,
    facts: (ctx) => [
      { label: "stage", value: ctx.attrs?.stageName, mono: true },
      {
        label: "invoke url",
        value: ctx.attrs?.invokeUrl,
        mono: true,
        href: ctx.attrs?.invokeUrl,
        copy: true,
      },
      { label: "api id", value: ctx.attrs?.apiId, mono: true, copy: true },
      { label: "auto deploy", value: ctx.attrs?.autoDeploy },
      { label: "deployment id", value: ctx.attrs?.deploymentId, mono: true },
    ],
  },
);

export const VpcLinkUI = UIProvider.succeed<VpcLink>(
  "AWS.ApiGatewayV2.VpcLink",
  {
    displayName: "API Gateway V2 VPC Link",
    icon: "cable",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "vpc link id",
        value: ctx.attrs?.vpcLinkId,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "subnets",
        value: ctx.attrs?.subnetIds?.length
          ? ctx.attrs.subnetIds.join(", ")
          : undefined,
        mono: true,
      },
      {
        label: "security groups",
        value: ctx.attrs?.securityGroupIds?.length
          ? ctx.attrs.securityGroupIds.join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    ApiUI,
    ApiMappingUI,
    AuthorizerUI,
    DomainNameUI,
    IntegrationUI,
    RouteUI,
    StageUI,
    VpcLinkUI,
  );
