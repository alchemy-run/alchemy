import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Alias } from "./Alias.ts";
import type { EventSourceMapping } from "./EventSourceMapping.ts";
import type { Function } from "./Function.ts";
import type { LayerVersion } from "./LayerVersion.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";
import type { NetworkConnector } from "./NetworkConnector.ts";
import type { Permission } from "./Permission.ts";
import type { Version } from "./Version.ts";

/**
 * Dashboard UI providers for AWS Lambda resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const FunctionUI = UIProvider.succeed<Function>("AWS.Lambda.Function", {
  displayName: "Lambda Function",
  icon: "zap",
  color: "#ED7100",
  category: "compute",
  summary: (ctx) => ctx.attrs?.functionName,
  link: (ctx) => ctx.attrs?.functionUrl,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.functionArn);
    return region === undefined || ctx.attrs?.functionName === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/functions/${ctx.attrs.functionName}`;
  },
  facts: (ctx) => [
    { label: "function", value: ctx.attrs?.functionName, copy: true },
    { label: "arn", value: ctx.attrs?.functionArn, mono: true, copy: true },
    {
      label: "url",
      value: ctx.attrs?.functionUrl,
      href: ctx.attrs?.functionUrl,
      copy: true,
    },
    { label: "role", value: ctx.attrs?.roleArn, mono: true, copy: true },
    { label: "runtime", value: ctx.props?.runtime },
    { label: "memory", value: ctx.props?.memorySize },
    { label: "code hash", value: ctx.attrs?.code?.hash, mono: true },
    {
      label: "reserved concurrency",
      value: ctx.attrs?.reservedConcurrentExecutions,
    },
  ],
});

export const PermissionUI = UIProvider.succeed<Permission>(
  "AWS.Lambda.Permission",
  {
    displayName: "Lambda Permission",
    icon: "key-round",
    color: "#ED7100",
    category: "security",
    summary: (ctx) => ctx.attrs?.statementId,
    facts: (ctx) => [
      { label: "statement", value: ctx.attrs?.statementId, mono: true },
      {
        label: "function",
        value: ctx.attrs?.functionName,
        mono: true,
        copy: true,
      },
      { label: "action", value: ctx.props?.action, mono: true },
      { label: "principal", value: ctx.props?.principal, mono: true },
      { label: "source arn", value: ctx.props?.sourceArn, mono: true },
    ],
  },
);

export const EventSourceMappingUI = UIProvider.succeed<EventSourceMapping>(
  "AWS.Lambda.EventSourceMapping",
  {
    displayName: "Event Source Mapping",
    icon: "webhook",
    color: "#ED7100",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.uuid,
    facts: (ctx) => [
      { label: "uuid", value: ctx.attrs?.uuid, mono: true, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.eventSourceMappingArn,
        mono: true,
        copy: true,
      },
      { label: "function", value: ctx.attrs?.functionArn, mono: true },
      { label: "source", value: ctx.props?.eventSourceArn, mono: true },
      { label: "state", value: ctx.attrs?.state },
      { label: "batch size", value: ctx.props?.batchSize },
    ],
  },
);

export const AliasUI = UIProvider.succeed<Alias>("AWS.Lambda.Alias", {
  displayName: "Lambda Alias",
  icon: "tag",
  color: "#ED7100",
  category: "compute",
  summary: (ctx) => ctx.attrs?.aliasName,
  facts: (ctx) => [
    { label: "alias", value: ctx.attrs?.aliasName },
    { label: "arn", value: ctx.attrs?.aliasArn, mono: true, copy: true },
    { label: "function", value: ctx.attrs?.functionName, mono: true },
    { label: "version", value: ctx.attrs?.functionVersion, mono: true },
  ],
});

export const VersionUI = UIProvider.succeed<Version>("AWS.Lambda.Version", {
  displayName: "Lambda Version",
  icon: "git-commit-horizontal",
  color: "#ED7100",
  category: "compute",
  summary: (ctx) =>
    ctx.attrs === undefined
      ? undefined
      : `${ctx.attrs.functionName}:${ctx.attrs.version}`,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.functionArn);
    return region === undefined || ctx.attrs === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/functions/${ctx.attrs.functionName}/versions/${ctx.attrs.version}`;
  },
  facts: (ctx) => [
    { label: "version", value: ctx.attrs?.version, mono: true, copy: true },
    { label: "function", value: ctx.attrs?.functionName, mono: true },
    { label: "arn", value: ctx.attrs?.versionArn, mono: true, copy: true },
    { label: "code sha256", value: ctx.attrs?.codeSha256, mono: true },
    { label: "config sha256", value: ctx.attrs?.configSha256, mono: true },
  ],
});

export const NetworkConnectorUI = UIProvider.succeed<NetworkConnector>(
  "AWS.Lambda.NetworkConnector",
  {
    displayName: "Lambda Network Connector",
    icon: "network",
    color: "#ED7100",
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.networkConnectorArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.networkConnectorId, mono: true },
      { label: "state", value: ctx.attrs?.state },
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

/**
 * Tag provenance: MicrovmImage registers via `Platform(MicrovmImageTypeId, ...)`
 * in MicrovmImage.ts, where the id is declared in MicrovmRuntimeContext.ts as
 * `const MicrovmImageTypeId = "AWS.Lambda.MicrovmImage"` (that module is not
 * browser-safe, so the string is inlined here).
 */
export const MicrovmImageUI = UIProvider.succeed<MicrovmImage>(
  "AWS.Lambda.MicrovmImage",
  {
    displayName: "Lambda MicroVM Image",
    icon: "box",
    color: "#ED7100",
    category: "compute",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "image", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.imageArn, mono: true, copy: true },
      { label: "state", value: ctx.attrs?.state },
      { label: "version", value: ctx.attrs?.imageVersion, mono: true },
      {
        label: "active version",
        value: ctx.attrs?.latestActiveImageVersion,
        mono: true,
      },
      {
        label: "code hash",
        value: ctx.attrs?.codeArtifact?.hash,
        mono: true,
      },
    ],
  },
);

export const LayerVersionUI = UIProvider.succeed<LayerVersion>(
  "AWS.Lambda.LayerVersion",
  {
    displayName: "Lambda Layer Version",
    icon: "layers",
    color: "#ED7100",
    category: "compute",
    summary: (ctx) =>
      ctx.attrs?.layerName === undefined
        ? undefined
        : `${ctx.attrs.layerName}:${ctx.attrs.version ?? ""}`,
    facts: (ctx) => [
      { label: "layer", value: ctx.attrs?.layerName, copy: true },
      { label: "arn", value: ctx.attrs?.layerArn, mono: true, copy: true },
      {
        label: "version arn",
        value: ctx.attrs?.layerVersionArn,
        mono: true,
        copy: true,
      },
      { label: "version", value: ctx.attrs?.version },
      { label: "code size", value: ctx.attrs?.codeSize },
      { label: "license", value: ctx.attrs?.licenseInfo },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    FunctionUI,
    PermissionUI,
    EventSourceMappingUI,
    AliasUI,
    VersionUI,
    NetworkConnectorUI,
    MicrovmImageUI,
    LayerVersionUI,
  );
