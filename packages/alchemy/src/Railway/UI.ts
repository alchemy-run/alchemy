import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { Bucket } from "./Bucket.ts";
import type { CloudAgent } from "./CloudAgent.ts";
import type { CustomDomain } from "./CustomDomain.ts";
import type { Function as RailwayFunction } from "./Function.ts";
import type { Group } from "./Group.ts";
import type { Mongo } from "./Mongo.ts";
import type { MySQL } from "./MySQL.ts";
import type { Postgres } from "./Postgres.ts";
import type {
  PrivateNetwork,
  PrivateNetworkEndpoint,
} from "./PrivateNetwork.ts";
import type { Project } from "./Project.ts";
import type { Environment } from "./ProjectEnvironment.ts";
import type { Redis } from "./Redis.ts";
import type { Sandbox } from "./Sandbox.ts";
import type { Service } from "./Service.ts";
import type { TcpProxy } from "./TcpProxy.ts";
import type { Template } from "./Template.ts";
import type { UsageLimit } from "./Usage.ts";
import type { Variable } from "./Variable.ts";
import type { Volume } from "./Volume.ts";
import type { VolumeBackup } from "./VolumeBackup.ts";
import type { Cdn } from "./Website/Cdn.ts";

/**
 * Dashboard UI providers for Railway resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Railway SDK code reaches the dashboard bundle.
 */

const RAILWAY_PURPLE = "#853BCE";

const projectUrl = (projectId: string | undefined): string | undefined =>
  projectId === undefined
    ? undefined
    : `https://railway.com/project/${projectId}`;

const serviceUrl = (
  projectId: string | undefined,
  serviceId: string | undefined,
  environmentId: string | undefined,
): string | undefined => {
  if (projectId === undefined || serviceId === undefined) return undefined;
  const base = `https://railway.com/project/${projectId}/service/${serviceId}`;
  return environmentId === undefined
    ? base
    : `${base}?environmentId=${environmentId}`;
};

export const ProjectUI = UIProvider.succeed<Project>("Railway.Project", {
  displayName: "Railway Project",
  icon: "train-front",
  color: RAILWAY_PURPLE,
  category: "other",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) => ctx.attrs?.url,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    {
      label: "project id",
      value: ctx.attrs?.projectId,
      mono: true,
      copy: true,
    },
    { label: "workspace id", value: ctx.attrs?.workspaceId, mono: true },
    { label: "base environment", value: ctx.attrs?.environmentId, mono: true },
    { label: "url", value: ctx.attrs?.url, href: ctx.attrs?.url },
  ],
});

export const EnvironmentUI = UIProvider.succeed<Environment>(
  "Railway.Environment",
  {
    displayName: "Railway Environment",
    icon: "layers",
    color: RAILWAY_PURPLE,
    category: "config",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) => ctx.attrs?.url,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "environment id",
        value: ctx.attrs?.environmentId,
        mono: true,
        copy: true,
      },
      { label: "project id", value: ctx.attrs?.projectId, mono: true },
      { label: "ephemeral", value: ctx.attrs?.isEphemeral },
      { label: "url", value: ctx.attrs?.url, href: ctx.attrs?.url },
    ],
  },
);

export const ServiceUI = UIProvider.succeed<Service>("Railway.Service", {
  displayName: "Railway Service",
  icon: "server",
  color: RAILWAY_PURPLE,
  category: "compute",
  summary: (ctx) => ctx.attrs?.name,
  link: (ctx) => ctx.attrs?.url,
  consoleUrl: (ctx) =>
    serviceUrl(
      ctx.attrs?.projectId,
      ctx.attrs?.serviceId,
      ctx.attrs?.environmentId,
    ),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    {
      label: "service id",
      value: ctx.attrs?.serviceId,
      mono: true,
      copy: true,
    },
    { label: "image", value: ctx.attrs?.image, mono: true },
    { label: "repo", value: ctx.attrs?.repo, mono: true },
    { label: "deployment", value: ctx.attrs?.deploymentStatus },
    { label: "private dns", value: ctx.attrs?.dnsName, mono: true, copy: true },
    {
      label: "url",
      value: ctx.attrs?.url,
      href: ctx.attrs?.url,
      copy: true,
    },
  ],
});

export const FunctionUI = UIProvider.succeed<RailwayFunction>(
  "Railway.Function",
  {
    displayName: "Railway Function",
    icon: "zap",
    color: RAILWAY_PURPLE,
    category: "compute",
    summary: (ctx) => ctx.attrs?.name,
    link: (ctx) => ctx.attrs?.url,
    consoleUrl: (ctx) =>
      serviceUrl(
        ctx.attrs?.projectId,
        ctx.attrs?.serviceId,
        ctx.attrs?.environmentId,
      ),
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "service id",
        value: ctx.attrs?.serviceId,
        mono: true,
        copy: true,
      },
      { label: "runtime", value: ctx.attrs?.runtime },
      { label: "cron", value: ctx.attrs?.cronSchedule, mono: true },
      { label: "deployment", value: ctx.attrs?.deploymentStatus },
      {
        label: "private dns",
        value: ctx.attrs?.dnsName,
        mono: true,
        copy: true,
      },
      {
        label: "url",
        value: ctx.attrs?.url,
        href: ctx.attrs?.url,
        copy: true,
      },
    ],
  },
);

export const PostgresUI = UIProvider.succeed<Postgres>("Railway.Postgres", {
  displayName: "Railway Postgres",
  icon: "database",
  color: RAILWAY_PURPLE,
  category: "database",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) =>
    serviceUrl(
      ctx.attrs?.projectId,
      ctx.attrs?.serviceId,
      ctx.attrs?.environmentId,
    ),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    {
      label: "service id",
      value: ctx.attrs?.serviceId,
      mono: true,
      copy: true,
    },
    { label: "image", value: ctx.attrs?.image, mono: true },
    { label: "database", value: ctx.attrs?.database },
    { label: "user", value: ctx.attrs?.user },
    {
      label: "public endpoint",
      value:
        ctx.attrs?.tcpProxyDomain !== undefined &&
        ctx.attrs?.tcpProxyPort !== undefined
          ? `${ctx.attrs.tcpProxyDomain}:${ctx.attrs.tcpProxyPort}`
          : undefined,
      mono: true,
      copy: true,
    },
    { label: "deployment", value: ctx.attrs?.deploymentStatus },
  ],
});

export const MySQLUI = UIProvider.succeed<MySQL>("Railway.MySQL", {
  displayName: "Railway MySQL",
  icon: "database",
  color: RAILWAY_PURPLE,
  category: "database",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) =>
    serviceUrl(
      ctx.attrs?.projectId,
      ctx.attrs?.serviceId,
      ctx.attrs?.environmentId,
    ),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    {
      label: "service id",
      value: ctx.attrs?.serviceId,
      mono: true,
      copy: true,
    },
    { label: "image", value: ctx.attrs?.image, mono: true },
    { label: "database", value: ctx.attrs?.database },
    { label: "user", value: ctx.attrs?.user },
    {
      label: "public endpoint",
      value:
        ctx.attrs?.tcpProxyDomain !== undefined &&
        ctx.attrs?.tcpProxyPort !== undefined
          ? `${ctx.attrs.tcpProxyDomain}:${ctx.attrs.tcpProxyPort}`
          : undefined,
      mono: true,
      copy: true,
    },
    { label: "deployment", value: ctx.attrs?.deploymentStatus },
  ],
});

export const MongoUI = UIProvider.succeed<Mongo>("Railway.Mongo", {
  displayName: "Railway Mongo",
  icon: "leaf",
  color: RAILWAY_PURPLE,
  category: "database",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) =>
    serviceUrl(
      ctx.attrs?.projectId,
      ctx.attrs?.serviceId,
      ctx.attrs?.environmentId,
    ),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    {
      label: "service id",
      value: ctx.attrs?.serviceId,
      mono: true,
      copy: true,
    },
    { label: "image", value: ctx.attrs?.image, mono: true },
    { label: "database", value: ctx.attrs?.database },
    { label: "user", value: ctx.attrs?.user },
    {
      label: "public endpoint",
      value:
        ctx.attrs?.tcpProxyDomain !== undefined &&
        ctx.attrs?.tcpProxyPort !== undefined
          ? `${ctx.attrs.tcpProxyDomain}:${ctx.attrs.tcpProxyPort}`
          : undefined,
      mono: true,
      copy: true,
    },
    { label: "deployment", value: ctx.attrs?.deploymentStatus },
  ],
});

export const RedisUI = UIProvider.succeed<Redis>("Railway.Redis", {
  displayName: "Railway Redis",
  icon: "database",
  color: RAILWAY_PURPLE,
  category: "database",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) =>
    serviceUrl(
      ctx.attrs?.projectId,
      ctx.attrs?.serviceId,
      ctx.attrs?.environmentId,
    ),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    {
      label: "service id",
      value: ctx.attrs?.serviceId,
      mono: true,
      copy: true,
    },
    { label: "image", value: ctx.attrs?.image, mono: true },
    { label: "port", value: ctx.attrs?.port },
    {
      label: "private host",
      value: ctx.attrs?.privateHost,
      mono: true,
      copy: true,
    },
    { label: "region", value: ctx.attrs?.region },
    { label: "deployment", value: ctx.attrs?.deploymentStatus },
  ],
});

export const BucketUI = UIProvider.succeed<Bucket>("Railway.Bucket", {
  displayName: "Railway Bucket",
  icon: "cylinder",
  color: RAILWAY_PURPLE,
  category: "storage",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) => projectUrl(ctx.attrs?.projectId),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "bucket id", value: ctx.attrs?.bucketId, mono: true, copy: true },
    {
      label: "s3 bucket",
      value: ctx.attrs?.s3BucketName,
      mono: true,
      copy: true,
    },
    {
      label: "endpoint",
      value: ctx.attrs?.endpoint,
      href: ctx.attrs?.endpoint,
      mono: true,
      copy: true,
    },
    { label: "region", value: ctx.attrs?.region },
    { label: "environment", value: ctx.attrs?.environmentId, mono: true },
  ],
});

export const VolumeUI = UIProvider.succeed<Volume>("Railway.Volume", {
  displayName: "Railway Volume",
  icon: "hard-drive",
  color: RAILWAY_PURPLE,
  category: "storage",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) => projectUrl(ctx.attrs?.projectId),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "volume id", value: ctx.attrs?.volumeId, mono: true, copy: true },
    { label: "mount path", value: ctx.attrs?.mountPath, mono: true },
    { label: "size (MB)", value: ctx.attrs?.sizeMB },
    { label: "state", value: ctx.attrs?.state },
    { label: "service", value: ctx.attrs?.serviceId, mono: true },
    { label: "region", value: ctx.attrs?.region },
  ],
});

export const VolumeBackupUI = UIProvider.succeed<VolumeBackup>(
  "Railway.VolumeBackup",
  {
    displayName: "Railway Volume Backup",
    icon: "archive",
    color: RAILWAY_PURPLE,
    category: "storage",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) => projectUrl(ctx.attrs?.projectId),
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "backup id",
        value: ctx.attrs?.volumeInstanceBackupId,
        mono: true,
        copy: true,
      },
      { label: "volume id", value: ctx.attrs?.volumeId, mono: true },
      { label: "used (MB)", value: ctx.attrs?.usedMB },
      { label: "locked", value: ctx.attrs?.locked },
      { label: "expires", value: ctx.attrs?.expiresAt },
      { label: "schedules", value: ctx.attrs?.schedules?.join(", ") },
    ],
  },
);

export const VariableUI = UIProvider.succeed<Variable>("Railway.Variable", {
  displayName: "Railway Variable",
  icon: "variable",
  color: RAILWAY_PURPLE,
  category: "config",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) =>
    serviceUrl(
      ctx.attrs?.projectId,
      ctx.attrs?.serviceId,
      ctx.attrs?.environmentId,
    ) ?? projectUrl(ctx.attrs?.projectId),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, mono: true, copy: true },
    { label: "digest", value: ctx.attrs?.digest, mono: true },
    { label: "service id", value: ctx.attrs?.serviceId, mono: true },
    { label: "environment", value: ctx.attrs?.environmentId, mono: true },
    { label: "project id", value: ctx.attrs?.projectId, mono: true },
  ],
});

export const CustomDomainUI = UIProvider.succeed<CustomDomain>(
  "Railway.CustomDomain",
  {
    displayName: "Railway Custom Domain",
    icon: "globe",
    color: RAILWAY_PURPLE,
    category: "dns",
    summary: (ctx) => ctx.attrs?.domain,
    link: (ctx) => ctx.attrs?.url,
    consoleUrl: (ctx) =>
      serviceUrl(
        ctx.attrs?.projectId,
        ctx.attrs?.serviceId,
        ctx.attrs?.environmentId,
      ),
    facts: (ctx) => [
      { label: "domain", value: ctx.attrs?.domain, copy: true },
      {
        label: "domain id",
        value: ctx.attrs?.customDomainId,
        mono: true,
        copy: true,
      },
      { label: "verified", value: ctx.attrs?.verified },
      { label: "certificate", value: ctx.attrs?.certificateStatus },
      { label: "target port", value: ctx.attrs?.targetPort },
      { label: "sync status", value: ctx.attrs?.syncStatus },
      {
        label: "url",
        value: ctx.attrs?.url,
        href: ctx.attrs?.url,
        copy: true,
      },
    ],
  },
);

export const TcpProxyUI = UIProvider.succeed<TcpProxy>("Railway.TcpProxy", {
  displayName: "Railway TCP Proxy",
  icon: "network",
  color: RAILWAY_PURPLE,
  category: "network",
  summary: (ctx) =>
    ctx.attrs?.domain !== undefined && ctx.attrs?.proxyPort !== undefined
      ? `${ctx.attrs.domain}:${ctx.attrs.proxyPort}`
      : undefined,
  facts: (ctx) => [
    {
      label: "endpoint",
      value:
        ctx.attrs?.domain !== undefined && ctx.attrs?.proxyPort !== undefined
          ? `${ctx.attrs.domain}:${ctx.attrs.proxyPort}`
          : undefined,
      mono: true,
      copy: true,
    },
    { label: "proxy id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "application port", value: ctx.attrs?.applicationPort },
    { label: "service id", value: ctx.attrs?.serviceId, mono: true },
    { label: "sync status", value: ctx.attrs?.syncStatus },
  ],
});

export const PrivateNetworkUI = UIProvider.succeed<PrivateNetwork>(
  "Railway.PrivateNetwork",
  {
    displayName: "Railway Private Network",
    icon: "network",
    color: RAILWAY_PURPLE,
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) => projectUrl(ctx.attrs?.projectId),
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "public id",
        value: ctx.attrs?.publicId,
        mono: true,
        copy: true,
      },
      { label: "network id", value: ctx.attrs?.networkId, mono: true },
      { label: "dns", value: ctx.attrs?.dnsName, mono: true, copy: true },
      { label: "environment", value: ctx.attrs?.environmentId, mono: true },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const PrivateNetworkEndpointUI =
  UIProvider.succeed<PrivateNetworkEndpoint>("Railway.PrivateNetworkEndpoint", {
    displayName: "Railway Private Network Endpoint",
    icon: "link",
    color: RAILWAY_PURPLE,
    category: "network",
    summary: (ctx) => ctx.attrs?.dnsName,
    consoleUrl: (ctx) =>
      serviceUrl(
        ctx.attrs?.projectId,
        ctx.attrs?.serviceId,
        ctx.attrs?.environmentId,
      ),
    facts: (ctx) => [
      { label: "dns", value: ctx.attrs?.dnsName, mono: true, copy: true },
      {
        label: "endpoint id",
        value: ctx.attrs?.publicId,
        mono: true,
        copy: true,
      },
      { label: "service id", value: ctx.attrs?.serviceId, mono: true },
      { label: "network id", value: ctx.attrs?.privateNetworkId, mono: true },
      {
        label: "private ips",
        value: ctx.attrs?.privateIps?.join(", "),
        mono: true,
      },
      { label: "sync status", value: ctx.attrs?.syncStatus },
    ],
  });

export const GroupUI = UIProvider.succeed<Group>("Railway.Group", {
  displayName: "Railway Group",
  icon: "boxes",
  color: RAILWAY_PURPLE,
  category: "other",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) => projectUrl(ctx.attrs?.projectId),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "group id", value: ctx.attrs?.groupId, mono: true, copy: true },
    { label: "services", value: ctx.attrs?.serviceIds?.length },
    { label: "volumes", value: ctx.attrs?.volumeIds?.length },
    { label: "buckets", value: ctx.attrs?.bucketIds?.length },
    { label: "collapsed", value: ctx.attrs?.collapsed },
  ],
});

export const TemplateUI = UIProvider.succeed<Template>("Railway.Template", {
  displayName: "Railway Template",
  icon: "layout-template",
  color: RAILWAY_PURPLE,
  category: "other",
  summary: (ctx) => ctx.attrs?.name ?? ctx.props?.templateId,
  consoleUrl: (ctx) => ctx.attrs?.url,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    {
      label: "template id",
      value: ctx.attrs?.templateId,
      mono: true,
      copy: true,
    },
    { label: "code", value: ctx.attrs?.code, mono: true },
    { label: "services", value: ctx.attrs?.serviceIds?.length },
    { label: "owns project", value: ctx.attrs?.ownsProject },
    { label: "url", value: ctx.attrs?.url, href: ctx.attrs?.url },
  ],
});

export const CloudAgentUI = UIProvider.succeed<CloudAgent>(
  "Railway.CloudAgent",
  {
    displayName: "Railway Cloud Agent",
    icon: "cpu",
    color: RAILWAY_PURPLE,
    category: "compute",
    summary: (ctx) => ctx.attrs?.name,
    link: (ctx) =>
      ctx.attrs?.domain === undefined
        ? undefined
        : `https://${ctx.attrs.domain}`,
    consoleUrl: (ctx) => projectUrl(ctx.attrs?.projectId),
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "agent id",
        value: ctx.attrs?.cloudAgentId,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "domain",
        value: ctx.attrs?.domain,
        href:
          ctx.attrs?.domain === undefined
            ? undefined
            : `https://${ctx.attrs.domain}`,
        copy: true,
      },
      { label: "environment", value: ctx.attrs?.environmentId, mono: true },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const SandboxUI = UIProvider.succeed<Sandbox>("Railway.Sandbox", {
  displayName: "Railway Sandbox",
  icon: "box",
  color: RAILWAY_PURPLE,
  category: "compute",
  summary: (ctx) => ctx.attrs?.sandboxId,
  consoleUrl: (ctx) => projectUrl(ctx.attrs?.projectId),
  facts: (ctx) => [
    {
      label: "sandbox id",
      value: ctx.attrs?.sandboxId,
      mono: true,
      copy: true,
    },
    { label: "status", value: ctx.attrs?.status },
    { label: "region", value: ctx.attrs?.region },
    { label: "isolation", value: ctx.attrs?.networkIsolation },
    { label: "idle timeout (min)", value: ctx.attrs?.idleTimeoutMinutes },
    { label: "environment", value: ctx.attrs?.environmentId, mono: true },
    { label: "created", value: ctx.attrs?.createdAt },
  ],
});

export const UsageLimitUI = UIProvider.succeed<UsageLimit>(
  "Railway.UsageLimit",
  {
    displayName: "Railway Usage Limit",
    icon: "wallet",
    color: RAILWAY_PURPLE,
    category: "billing",
    summary: (ctx) =>
      ctx.attrs?.softLimitDollars === undefined
        ? undefined
        : `$${ctx.attrs.softLimitDollars} soft cap`,
    facts: (ctx) => [
      {
        label: "soft limit",
        value:
          ctx.attrs?.softLimitDollars === undefined
            ? undefined
            : `$${ctx.attrs.softLimitDollars}`,
      },
      {
        label: "hard limit",
        value:
          ctx.attrs?.hardLimitDollars === undefined
            ? undefined
            : `$${ctx.attrs.hardLimitDollars}`,
      },
      { label: "over limit", value: ctx.attrs?.isOverLimit },
      { label: "customer id", value: ctx.attrs?.customerId, mono: true },
      { label: "workspace id", value: ctx.attrs?.workspaceId, mono: true },
      {
        label: "limit id",
        value: ctx.attrs?.usageLimitId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const CdnUI = UIProvider.succeed<Cdn>("Railway.Website.Cdn", {
  displayName: "Railway Website CDN",
  icon: "cloud",
  color: RAILWAY_PURPLE,
  category: "cdn",
  summary: (ctx) => ctx.attrs?.edgeConfigId,
  facts: (ctx) => [
    {
      label: "edge config id",
      value: ctx.attrs?.edgeConfigId,
      mono: true,
      copy: true,
    },
    { label: "enabled", value: ctx.attrs?.enabled },
    { label: "service id", value: ctx.attrs?.serviceId, mono: true },
    { label: "environment", value: ctx.attrs?.environmentId, mono: true },
    { label: "html caching", value: ctx.props?.htmlCaching },
    { label: "purge on deploy", value: ctx.props?.purgeOnDeploy },
    { label: "default ttl (s)", value: ctx.props?.defaultTtlSeconds },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    ProjectUI,
    EnvironmentUI,
    ServiceUI,
    FunctionUI,
    PostgresUI,
    MySQLUI,
    MongoUI,
    RedisUI,
    BucketUI,
    VolumeUI,
    VolumeBackupUI,
    VariableUI,
    CustomDomainUI,
    TcpProxyUI,
    PrivateNetworkUI,
    PrivateNetworkEndpointUI,
    GroupUI,
    TemplateUI,
    CloudAgentUI,
    SandboxUI,
    UsageLimitUI,
    CdnUI,
  );
