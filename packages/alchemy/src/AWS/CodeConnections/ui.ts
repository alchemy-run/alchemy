import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Connection } from "./Connection.ts";
import type { Host } from "./Host.ts";
import type { RepositoryLink } from "./RepositoryLink.ts";
import type { SyncConfiguration } from "./SyncConfiguration.ts";

/**
 * Dashboard UI providers for AWS CodeConnections resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance (CodeConnections) brand pink. */
const COLOR = "#E7157B";

export const ConnectionUI = UIProvider.succeed<Connection>(
  "AWS.CodeConnections.Connection",
  {
    displayName: "CodeConnections Connection",
    icon: "link",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.connectionName,
    facts: (ctx) => [
      { label: "connection", value: ctx.attrs?.connectionName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.connectionArn,
        mono: true,
        copy: true,
      },
      { label: "provider", value: ctx.attrs?.providerType },
      { label: "status", value: ctx.attrs?.connectionStatus },
    ],
  },
);

export const HostUI = UIProvider.succeed<Host>("AWS.CodeConnections.Host", {
  displayName: "CodeConnections Host",
  icon: "server",
  color: COLOR,
  category: "config",
  summary: (ctx) => ctx.attrs?.hostName,
  facts: (ctx) => [
    { label: "host", value: ctx.attrs?.hostName, copy: true },
    { label: "arn", value: ctx.attrs?.hostArn, mono: true, copy: true },
    { label: "provider", value: ctx.attrs?.providerType },
    { label: "endpoint", value: ctx.attrs?.providerEndpoint, mono: true },
    { label: "status", value: ctx.attrs?.hostStatus },
  ],
});

export const RepositoryLinkUI = UIProvider.succeed<RepositoryLink>(
  "AWS.CodeConnections.RepositoryLink",
  {
    displayName: "CodeConnections Repository Link",
    icon: "git-branch",
    color: COLOR,
    category: "config",
    summary: (ctx) =>
      ctx.attrs?.ownerId && ctx.attrs?.repositoryName
        ? `${ctx.attrs.ownerId}/${ctx.attrs.repositoryName}`
        : ctx.attrs?.repositoryLinkId,
    facts: (ctx) => [
      {
        label: "id",
        value: ctx.attrs?.repositoryLinkId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.repositoryLinkArn,
        mono: true,
        copy: true,
      },
      { label: "owner", value: ctx.attrs?.ownerId, copy: true },
      { label: "repository", value: ctx.attrs?.repositoryName, copy: true },
      { label: "provider", value: ctx.attrs?.providerType },
      {
        label: "connection",
        value: ctx.attrs?.connectionArn,
        mono: true,
      },
    ],
  },
);

export const SyncConfigurationUI = UIProvider.succeed<SyncConfiguration>(
  "AWS.CodeConnections.SyncConfiguration",
  {
    displayName: "CodeConnections Sync Configuration",
    icon: "repeat",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.resourceName,
    facts: (ctx) => [
      { label: "resource", value: ctx.attrs?.resourceName, copy: true },
      { label: "sync type", value: ctx.attrs?.syncType },
      { label: "branch", value: ctx.attrs?.branch },
      { label: "config file", value: ctx.attrs?.configFile, mono: true },
      {
        label: "repository link",
        value: ctx.attrs?.repositoryLinkId,
        mono: true,
        copy: true,
      },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ConnectionUI, HostUI, RepositoryLinkUI, SyncConfigurationUI);
