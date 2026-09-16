import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ConditionalForwarder } from "./ConditionalForwarder.ts";
import type { Directory } from "./Directory.ts";
import type { EventTopic } from "./EventTopic.ts";

/**
 * Dashboard UI providers for AWS Directory Service resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Security, Identity & Compliance (Directory Service) brand red. */
const COLOR = "#DD344C";

export const DirectoryUI = UIProvider.succeed<Directory>(
  "AWS.DirectoryService.Directory",
  {
    displayName: "Directory",
    icon: "users",
    color: COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.directoryName,
    facts: (ctx) => [
      { label: "directory", value: ctx.attrs?.directoryName, copy: true },
      { label: "id", value: ctx.attrs?.directoryId, mono: true, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.directoryArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "stage", value: ctx.attrs?.stage },
      { label: "access url", value: ctx.attrs?.accessUrl, mono: true },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      {
        label: "dns addresses",
        value: ctx.attrs?.dnsIpAddrs?.length
          ? ctx.attrs.dnsIpAddrs.join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const ConditionalForwarderUI = UIProvider.succeed<ConditionalForwarder>(
  "AWS.DirectoryService.ConditionalForwarder",
  {
    displayName: "Directory Conditional Forwarder",
    icon: "route",
    color: COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.remoteDomainName,
    facts: (ctx) => [
      { label: "domain", value: ctx.attrs?.remoteDomainName, copy: true },
      {
        label: "directory",
        value: ctx.attrs?.directoryId,
        mono: true,
        copy: true,
      },
      {
        label: "dns addresses",
        value: ctx.attrs?.dnsIpAddrs?.length
          ? ctx.attrs.dnsIpAddrs.join(", ")
          : undefined,
        mono: true,
      },
      { label: "replication scope", value: ctx.attrs?.replicationScope },
    ],
  },
);

export const EventTopicUI = UIProvider.succeed<EventTopic>(
  "AWS.DirectoryService.EventTopic",
  {
    displayName: "Directory Event Topic",
    icon: "bell",
    color: COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.topicName,
    facts: (ctx) => [
      { label: "topic", value: ctx.attrs?.topicName, copy: true },
      {
        label: "topic arn",
        value: ctx.attrs?.topicArn,
        mono: true,
        copy: true,
      },
      {
        label: "directory",
        value: ctx.attrs?.directoryId,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(DirectoryUI, ConditionalForwarderUI, EventTopicUI);
