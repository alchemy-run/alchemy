import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Account } from "./Account.ts";
import type { ApiKey } from "./ApiKey.ts";
import type { Authorizer } from "./Authorizer.ts";
import type { BasePathMapping } from "./BasePathMapping.ts";
import type { DeploymentType } from "./Deployment.ts";
import type { DomainName } from "./DomainName.ts";
import type { ApiGatewayResource } from "./GatewayResource.ts";
import type { GatewayResponse } from "./GatewayResponse.ts";
import type { MethodType } from "./Method.ts";
import type { RestApi } from "./RestApi.ts";
import type { ApiGatewayStage } from "./Stage.ts";
import type { UsagePlan } from "./UsagePlan.ts";
import type { UsagePlanKey } from "./UsagePlanKey.ts";
import type { VpcLink } from "./VpcLink.ts";

/**
 * Dashboard UI providers for AWS API Gateway resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS App Integration (API Gateway) brand pink. */
const COLOR = "#E7157B";

export const RestApiUI = UIProvider.succeed<RestApi>("AWS.ApiGateway.RestApi", {
  displayName: "API Gateway REST API",
  icon: "network",
  color: COLOR,
  category: "network",
  summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.restApiId,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name },
    { label: "api id", value: ctx.attrs?.restApiId, mono: true, copy: true },
    {
      label: "root resource",
      value: ctx.attrs?.rootResourceId,
      mono: true,
      copy: true,
    },
    {
      label: "endpoint types",
      value: ctx.attrs?.endpointConfiguration?.types?.join(", "),
    },
    { label: "api key source", value: ctx.attrs?.apiKeySource },
    {
      label: "execute-api endpoint",
      value:
        ctx.attrs?.disableExecuteApiEndpoint === undefined
          ? undefined
          : ctx.attrs.disableExecuteApiEndpoint
            ? "disabled"
            : "enabled",
    },
    { label: "description", value: ctx.attrs?.description },
  ],
});

/**
 * GatewayResource.ts imports the resource factory aliased
 * (`Resource as ResourceFactory`), so its declaration reads
 * `ResourceFactory<ApiGatewayResource>("AWS.ApiGateway.Resource")` —
 * equivalent to `Resource<ApiGatewayResource>("AWS.ApiGateway.Resource")`.
 * The tag below is that exact type string, not a guess.
 */
export const GatewayResourceUI = UIProvider.succeed<ApiGatewayResource>(
  "AWS.ApiGateway.Resource",
  {
    displayName: "API Gateway Resource",
    icon: "route",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.pathPart,
    facts: (ctx) => [
      { label: "path part", value: ctx.attrs?.pathPart, mono: true },
      {
        label: "resource id",
        value: ctx.attrs?.resourceId,
        mono: true,
        copy: true,
      },
      { label: "parent id", value: ctx.attrs?.parentId, mono: true },
      { label: "api id", value: ctx.attrs?.restApiId, mono: true, copy: true },
    ],
  },
);

export const MethodUI = UIProvider.succeed<MethodType>(
  "AWS.ApiGateway.Method",
  {
    displayName: "API Gateway Method",
    icon: "arrow-right-left",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.httpMethod,
    facts: (ctx) => [
      { label: "http method", value: ctx.attrs?.httpMethod, mono: true },
      {
        label: "resource id",
        value: ctx.attrs?.resourceId,
        mono: true,
        copy: true,
      },
      { label: "api id", value: ctx.attrs?.restApiId, mono: true, copy: true },
      { label: "authorization", value: ctx.attrs?.authorizationType },
      { label: "authorizer id", value: ctx.attrs?.authorizerId, mono: true },
      { label: "api key required", value: ctx.attrs?.apiKeyRequired },
      { label: "integration", value: ctx.attrs?.integration?.type },
    ],
  },
);

export const DeploymentUI = UIProvider.succeed<DeploymentType>(
  "AWS.ApiGateway.Deployment",
  {
    displayName: "API Gateway Deployment",
    icon: "rocket",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.deploymentId,
    facts: (ctx) => [
      {
        label: "deployment id",
        value: ctx.attrs?.deploymentId,
        mono: true,
        copy: true,
      },
      { label: "api id", value: ctx.attrs?.restApiId, mono: true, copy: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const StageUI = UIProvider.succeed<ApiGatewayStage>(
  "AWS.ApiGateway.Stage",
  {
    displayName: "API Gateway Stage",
    icon: "layers",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.stageName,
    facts: (ctx) => [
      { label: "stage", value: ctx.attrs?.stageName, mono: true },
      { label: "api id", value: ctx.attrs?.restApiId, mono: true, copy: true },
      {
        label: "deployment id",
        value: ctx.attrs?.deploymentId,
        mono: true,
        copy: true,
      },
      { label: "tracing", value: ctx.attrs?.tracingEnabled },
      { label: "cache cluster", value: ctx.attrs?.cacheClusterEnabled },
      { label: "web acl", value: ctx.attrs?.webAclArn, mono: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const DomainNameUI = UIProvider.succeed<DomainName>(
  "AWS.ApiGateway.DomainName",
  {
    displayName: "API Gateway Domain Name",
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
      {
        label: "regional domain",
        value: ctx.attrs?.regionalDomainName,
        mono: true,
        copy: true,
      },
      {
        label: "regional zone id",
        value: ctx.attrs?.regionalHostedZoneId,
        mono: true,
      },
      {
        label: "distribution domain",
        value: ctx.attrs?.distributionDomainName,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.domainNameArn, mono: true, copy: true },
    ],
  },
);

export const BasePathMappingUI = UIProvider.succeed<BasePathMapping>(
  "AWS.ApiGateway.BasePathMapping",
  {
    displayName: "API Gateway Base Path Mapping",
    icon: "link-2",
    color: COLOR,
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.domainName === undefined
        ? undefined
        : `${ctx.attrs.domainName}/${ctx.attrs.basePath === "(none)" || ctx.attrs.basePath === undefined ? "" : ctx.attrs.basePath}`,
    facts: (ctx) => [
      { label: "domain", value: ctx.attrs?.domainName, copy: true },
      { label: "base path", value: ctx.attrs?.basePath, mono: true },
      { label: "api id", value: ctx.attrs?.restApiId, mono: true, copy: true },
      { label: "stage", value: ctx.attrs?.stage, mono: true },
    ],
  },
);

export const AuthorizerUI = UIProvider.succeed<Authorizer>(
  "AWS.ApiGateway.Authorizer",
  {
    displayName: "API Gateway Authorizer",
    icon: "shield-check",
    color: COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      {
        label: "authorizer id",
        value: ctx.attrs?.authorizerId,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "api id", value: ctx.attrs?.restApiId, mono: true, copy: true },
    ],
  },
);

export const ApiKeyUI = UIProvider.succeed<ApiKey>("AWS.ApiGateway.ApiKey", {
  displayName: "API Gateway API Key",
  icon: "key-round",
  color: COLOR,
  category: "auth",
  summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.id,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name },
    { label: "key id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "enabled", value: ctx.attrs?.enabled },
  ],
});

export const UsagePlanUI = UIProvider.succeed<UsagePlan>(
  "AWS.ApiGateway.UsagePlan",
  {
    displayName: "API Gateway Usage Plan",
    icon: "gauge",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.id,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "plan id", value: ctx.attrs?.id, mono: true, copy: true },
      {
        label: "stages",
        value: ctx.attrs?.apiStages
          ?.map((s) => `${s.apiId ?? "?"}:${s.stage ?? "?"}`)
          .join(", "),
        mono: true,
      },
      {
        label: "throttle",
        value:
          ctx.attrs?.throttle === undefined
            ? undefined
            : `${ctx.attrs.throttle.rateLimit ?? "-"} rps / burst ${ctx.attrs.throttle.burstLimit ?? "-"}`,
      },
      {
        label: "quota",
        value:
          ctx.attrs?.quota === undefined
            ? undefined
            : `${ctx.attrs.quota.limit ?? "-"} per ${ctx.attrs.quota.period ?? "-"}`,
      },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const UsagePlanKeyUI = UIProvider.succeed<UsagePlanKey>(
  "AWS.ApiGateway.UsagePlanKey",
  {
    displayName: "API Gateway Usage Plan Key",
    icon: "key",
    color: COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.keyId,
    facts: (ctx) => [
      { label: "key id", value: ctx.attrs?.keyId, mono: true, copy: true },
      { label: "key type", value: ctx.attrs?.keyType },
      {
        label: "usage plan id",
        value: ctx.attrs?.usagePlanId,
        mono: true,
        copy: true,
      },
      { label: "name", value: ctx.attrs?.name },
    ],
  },
);

export const VpcLinkUI = UIProvider.succeed<VpcLink>("AWS.ApiGateway.VpcLink", {
  displayName: "API Gateway VPC Link",
  icon: "cable",
  color: COLOR,
  category: "network",
  summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.vpcLinkId,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name },
    {
      label: "vpc link id",
      value: ctx.attrs?.vpcLinkId,
      mono: true,
      copy: true,
    },
    { label: "status", value: ctx.attrs?.status },
    {
      label: "targets",
      value: ctx.attrs?.targetArns?.join(", "),
      mono: true,
    },
    { label: "description", value: ctx.attrs?.description },
  ],
});

export const GatewayResponseUI = UIProvider.succeed<GatewayResponse>(
  "AWS.ApiGateway.GatewayResponse",
  {
    displayName: "API Gateway Response",
    icon: "reply",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.responseType,
    facts: (ctx) => [
      { label: "response type", value: ctx.attrs?.responseType, mono: true },
      { label: "status code", value: ctx.attrs?.statusCode, mono: true },
      { label: "api id", value: ctx.attrs?.restApiId, mono: true, copy: true },
    ],
  },
);

export const AccountUI = UIProvider.succeed<Account>("AWS.ApiGateway.Account", {
  displayName: "API Gateway Account",
  icon: "settings",
  color: COLOR,
  category: "config",
  summary: (ctx) => ctx.attrs?.cloudwatchRoleArn,
  facts: (ctx) => [
    {
      label: "cloudwatch role",
      value: ctx.attrs?.cloudwatchRoleArn,
      mono: true,
      copy: true,
    },
    {
      label: "manages role",
      value: ctx.attrs?.managesCloudwatchRoleArn,
    },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    RestApiUI,
    GatewayResourceUI,
    MethodUI,
    DeploymentUI,
    StageUI,
    DomainNameUI,
    BasePathMappingUI,
    AuthorizerUI,
    ApiKeyUI,
    UsagePlanUI,
    UsagePlanKeyUI,
    VpcLinkUI,
    GatewayResponseUI,
    AccountUI,
  );
