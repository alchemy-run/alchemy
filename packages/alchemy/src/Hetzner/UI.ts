import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { Certificate } from "./Certificate.ts";
import type { Firewall } from "./Firewall.ts";
import type { FloatingIp } from "./FloatingIp.ts";
import type { FloatingIpAssignment } from "./FloatingIpAssignment.ts";
import type { Image } from "./Image.ts";
import type { LoadBalancer } from "./LoadBalancer.ts";
import type { Network } from "./Network.ts";
import type { PlacementGroup } from "./PlacementGroup.ts";
import type { PrimaryIp } from "./PrimaryIp.ts";
import type { RecordSet } from "./RecordSet.ts";
import type { Server } from "./Server.ts";
import type { Service } from "./Service.ts";
import type { SshKey } from "./SshKey.ts";
import type { Volume } from "./Volume.ts";
import type { VolumeAttachment } from "./VolumeAttachment.ts";
import type { Zone } from "./Zone.ts";

/**
 * Dashboard UI providers for Hetzner resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Hetzner SDK code reaches the dashboard bundle.
 */

const HETZNER_RED = "#D50C2D";

export const CertificateUI = UIProvider.succeed<Certificate>(
  "Hetzner.Certificate",
  {
    displayName: "Hetzner Certificate",
    icon: "shield-check",
    color: HETZNER_RED,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      {
        label: "domains",
        value: ctx.attrs?.domainNames?.length
          ? ctx.attrs.domainNames.join(", ")
          : undefined,
      },
      {
        label: "fingerprint",
        value: ctx.attrs?.fingerprint,
        mono: true,
        copy: true,
      },
      { label: "expires", value: ctx.attrs?.notValidAfter ?? undefined },
    ],
  },
);

export const FirewallUI = UIProvider.succeed<Firewall>("Hetzner.Firewall", {
  displayName: "Hetzner Firewall",
  icon: "shield",
  color: HETZNER_RED,
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "rules", value: ctx.attrs?.rules?.length },
    { label: "applied to", value: ctx.attrs?.appliedTo?.length },
    { label: "created", value: ctx.attrs?.created },
  ],
});

export const FloatingIpUI = UIProvider.succeed<FloatingIp>(
  "Hetzner.FloatingIp",
  {
    displayName: "Hetzner Floating IP",
    icon: "map-pin",
    color: HETZNER_RED,
    category: "network",
    summary: (ctx) => ctx.attrs?.ip ?? ctx.attrs?.name,
    facts: (ctx) => [
      { label: "ip", value: ctx.attrs?.ip, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "home location", value: ctx.attrs?.homeLocation },
      {
        label: "server",
        value: ctx.attrs?.serverId ?? undefined,
        mono: true,
      },
    ],
  },
);

export const FloatingIpAssignmentUI = UIProvider.succeed<FloatingIpAssignment>(
  "Hetzner.FloatingIpAssignment",
  {
    displayName: "Hetzner Floating IP Assignment",
    icon: "link",
    color: HETZNER_RED,
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.floatingIpId !== undefined && ctx.attrs?.serverId !== undefined
        ? `ip ${ctx.attrs.floatingIpId} -> server ${ctx.attrs.serverId}`
        : undefined,
    facts: (ctx) => [
      {
        label: "floating ip id",
        value: ctx.attrs?.floatingIpId,
        mono: true,
        copy: true,
      },
      {
        label: "server id",
        value: ctx.attrs?.serverId,
        mono: true,
        copy: true,
      },
      {
        label: "assignment",
        value:
          ctx.attrs?.floatingIpId !== undefined &&
          ctx.attrs?.serverId !== undefined
            ? `${ctx.attrs.floatingIpId} -> ${ctx.attrs.serverId}`
            : undefined,
        mono: true,
      },
    ],
  },
);

export const ImageUI = UIProvider.succeed<Image>("Hetzner.Image", {
  displayName: "Hetzner Image",
  icon: "disc",
  color: HETZNER_RED,
  category: "storage",
  summary: (ctx) => ctx.attrs?.description ?? ctx.attrs?.name ?? undefined,
  facts: (ctx) => [
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "status", value: ctx.attrs?.status },
    { label: "os flavor", value: ctx.attrs?.osFlavor },
    {
      label: "disk size",
      value:
        ctx.attrs?.diskSize !== undefined
          ? `${ctx.attrs.diskSize} GB`
          : undefined,
    },
    {
      label: "image size",
      value:
        ctx.attrs?.imageSize !== undefined && ctx.attrs.imageSize !== null
          ? `${ctx.attrs.imageSize} GB`
          : undefined,
    },
    {
      label: "created from",
      value:
        ctx.attrs?.createdFromName ?? ctx.attrs?.createdFromId ?? undefined,
    },
  ],
});

export const LoadBalancerUI = UIProvider.succeed<LoadBalancer>(
  "Hetzner.LoadBalancer",
  {
    displayName: "Hetzner Load Balancer",
    icon: "split",
    color: HETZNER_RED,
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.loadBalancerType },
      { label: "location", value: ctx.attrs?.location },
      {
        label: "ipv4",
        value: ctx.attrs?.ipv4 ?? undefined,
        mono: true,
        copy: true,
      },
      { label: "listeners", value: ctx.attrs?.services?.length },
      { label: "targets", value: ctx.attrs?.targets?.length },
    ],
  },
);

export const NetworkUI = UIProvider.succeed<Network>("Hetzner.Network", {
  displayName: "Hetzner Network",
  icon: "network",
  color: HETZNER_RED,
  category: "network",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.networkId, mono: true, copy: true },
    { label: "ip range", value: ctx.attrs?.ipRange, mono: true, copy: true },
    { label: "subnets", value: ctx.attrs?.subnets?.length },
    { label: "routes", value: ctx.attrs?.routes?.length },
    { label: "servers", value: ctx.attrs?.servers?.length },
    { label: "created", value: ctx.attrs?.created },
  ],
});

export const PlacementGroupUI = UIProvider.succeed<PlacementGroup>(
  "Hetzner.PlacementGroup",
  {
    displayName: "Hetzner Placement Group",
    icon: "boxes",
    color: HETZNER_RED,
    category: "compute",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "servers", value: ctx.attrs?.servers?.length },
      { label: "created", value: ctx.attrs?.created },
    ],
  },
);

export const PrimaryIpUI = UIProvider.succeed<PrimaryIp>("Hetzner.PrimaryIp", {
  displayName: "Hetzner Primary IP",
  icon: "globe",
  color: HETZNER_RED,
  category: "network",
  summary: (ctx) => ctx.attrs?.ip ?? ctx.attrs?.name,
  facts: (ctx) => [
    { label: "ip", value: ctx.attrs?.ip, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "location", value: ctx.attrs?.location },
    {
      label: "assignee",
      value: ctx.attrs?.assigneeId ?? undefined,
      mono: true,
    },
    { label: "auto delete", value: ctx.attrs?.autoDelete },
  ],
});

export const RecordSetUI = UIProvider.succeed<RecordSet>("Hetzner.RecordSet", {
  displayName: "Hetzner DNS Record Set",
  icon: "list-ordered",
  color: HETZNER_RED,
  category: "dns",
  summary: (ctx) => ctx.attrs?.id,
  facts: (ctx) => [
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "ttl", value: ctx.attrs?.ttl },
    {
      label: "values",
      value: ctx.attrs?.records?.length
        ? ctx.attrs.records.map((record) => record.value).join(", ")
        : undefined,
      mono: true,
      copy: true,
    },
    { label: "zone id", value: ctx.attrs?.zoneId, mono: true },
  ],
});

export const ServerUI = UIProvider.succeed<Server>("Hetzner.Server", {
  displayName: "Hetzner Server",
  icon: "server",
  color: HETZNER_RED,
  category: "compute",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "server type", value: ctx.attrs?.serverType },
    { label: "location", value: ctx.attrs?.location },
    { label: "ipv4", value: ctx.attrs?.ipv4, mono: true, copy: true },
    { label: "ipv6", value: ctx.attrs?.ipv6, mono: true, copy: true },
  ],
});

export const ServiceUI = UIProvider.succeed<Service>("Hetzner.Service", {
  displayName: "Hetzner Service",
  icon: "app-window",
  color: HETZNER_RED,
  category: "compute",
  summary: (ctx) => ctx.attrs?.url ?? ctx.attrs?.unitName,
  link: (ctx) => ctx.attrs?.url,
  facts: (ctx) => [
    {
      label: "url",
      value: ctx.attrs?.url,
      href: ctx.attrs?.url,
      copy: true,
    },
    { label: "unit", value: ctx.attrs?.unitName, mono: true, copy: true },
    { label: "server id", value: ctx.attrs?.serverId, mono: true },
    { label: "ipv4", value: ctx.attrs?.ipv4, mono: true, copy: true },
    { label: "port", value: ctx.attrs?.port },
    { label: "code hash", value: ctx.attrs?.code?.hash, mono: true },
  ],
});

export const SshKeyUI = UIProvider.succeed<SshKey>("Hetzner.SshKey", {
  displayName: "Hetzner SSH Key",
  icon: "key",
  color: HETZNER_RED,
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    {
      label: "fingerprint",
      value: ctx.attrs?.fingerprint,
      mono: true,
      copy: true,
    },
    { label: "created", value: ctx.attrs?.created },
  ],
});

export const VolumeUI = UIProvider.succeed<Volume>("Hetzner.Volume", {
  displayName: "Hetzner Volume",
  icon: "hard-drive",
  color: HETZNER_RED,
  category: "storage",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    {
      label: "size",
      value: ctx.attrs?.size !== undefined ? `${ctx.attrs.size} GB` : undefined,
    },
    { label: "format", value: ctx.attrs?.format },
    { label: "location", value: ctx.attrs?.location },
    {
      label: "server",
      value: ctx.attrs?.serverId ?? undefined,
      mono: true,
    },
    {
      label: "device",
      value: ctx.attrs?.linuxDevice,
      mono: true,
      copy: true,
    },
  ],
});

export const VolumeAttachmentUI = UIProvider.succeed<VolumeAttachment>(
  "Hetzner.VolumeAttachment",
  {
    displayName: "Hetzner Volume Attachment",
    icon: "anchor",
    color: HETZNER_RED,
    category: "storage",
    summary: (ctx) =>
      ctx.attrs?.volumeId !== undefined && ctx.attrs?.serverId !== undefined
        ? `volume ${ctx.attrs.volumeId} -> server ${ctx.attrs.serverId}`
        : undefined,
    facts: (ctx) => [
      {
        label: "volume id",
        value: ctx.attrs?.volumeId,
        mono: true,
        copy: true,
      },
      {
        label: "server id",
        value: ctx.attrs?.serverId,
        mono: true,
        copy: true,
      },
      { label: "automount", value: ctx.attrs?.automount },
      {
        label: "device",
        value: ctx.attrs?.linuxDevice,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ZoneUI = UIProvider.succeed<Zone>("Hetzner.Zone", {
  displayName: "Hetzner DNS Zone",
  icon: "globe",
  color: HETZNER_RED,
  category: "dns",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
    { label: "mode", value: ctx.attrs?.mode },
    { label: "status", value: ctx.attrs?.status },
    { label: "ttl", value: ctx.attrs?.ttl },
    { label: "records", value: ctx.attrs?.recordCount },
    {
      label: "nameservers",
      value: ctx.attrs?.assignedNameservers?.length
        ? ctx.attrs.assignedNameservers.join(", ")
        : undefined,
      mono: true,
      copy: true,
    },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    CertificateUI,
    FirewallUI,
    FloatingIpUI,
    FloatingIpAssignmentUI,
    ImageUI,
    LoadBalancerUI,
    NetworkUI,
    PlacementGroupUI,
    PrimaryIpUI,
    RecordSetUI,
    ServerUI,
    ServiceUI,
    SshKeyUI,
    VolumeUI,
    VolumeAttachmentUI,
    ZoneUI,
  );
