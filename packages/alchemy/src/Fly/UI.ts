import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { App } from "./App.ts";
import type { Bucket } from "./Bucket.ts";
import type { Certificate } from "./Certificate.ts";
import type { IpAssignment } from "./IpAssignment.ts";
import type { Machine } from "./Machine.ts";
import type { Postgres } from "./Postgres.ts";
import type { Redis } from "./Redis.ts";
import type { Secret } from "./Secret.ts";
import type { SecretKey } from "./SecretKey.ts";
import type { Service } from "./Service.ts";
import type { Sprite } from "./Sprite.ts";
import type { VolumeSnapshot } from "./VolumeSnapshot.ts";
import type { AssetDeployment } from "./Website/AssetDeployment.ts";

/**
 * Dashboard UI providers for Fly.io resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Fly SDK code reaches the dashboard bundle.
 */

const FLY_PURPLE = "#7B3FE4";

export const AppUI = UIProvider.succeed<App>("Fly.App", {
  displayName: "Fly App",
  icon: "app-window",
  color: FLY_PURPLE,
  category: "compute",
  summary: (ctx) => ctx.attrs?.appName,
  link: (ctx) => ctx.attrs?.url,
  consoleUrl: (ctx) =>
    ctx.attrs?.appName ? `https://fly.io/apps/${ctx.attrs.appName}` : undefined,
  facts: (ctx) => [
    { label: "app", value: ctx.attrs?.appName, copy: true },
    { label: "app id", value: ctx.attrs?.appId, mono: true, copy: true },
    { label: "org", value: ctx.attrs?.orgSlug },
    { label: "status", value: ctx.attrs?.status },
    { label: "network", value: ctx.attrs?.network },
    { label: "machines", value: ctx.attrs?.machineCount },
    { label: "url", value: ctx.attrs?.url, href: ctx.attrs?.url },
  ],
});

export const BucketUI = UIProvider.succeed<Bucket>("Fly.Bucket", {
  displayName: "Fly Bucket",
  icon: "cylinder",
  color: FLY_PURPLE,
  category: "storage",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) => ctx.attrs?.ssoLink,
  facts: (ctx) => [
    { label: "bucket", value: ctx.attrs?.name, copy: true },
    { label: "add-on id", value: ctx.attrs?.addOnId, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "org", value: ctx.attrs?.orgSlug },
    { label: "public", value: ctx.attrs?.public },
    { label: "domain", value: ctx.attrs?.domainName },
    { label: "created", value: ctx.attrs?.createdAt },
  ],
});

export const CertificateUI = UIProvider.succeed<Certificate>(
  "Fly.Certificate",
  {
    displayName: "Fly Certificate",
    icon: "shield-check",
    color: FLY_PURPLE,
    category: "security",
    summary: (ctx) => ctx.attrs?.hostname,
    consoleUrl: (ctx) =>
      ctx.attrs?.appName && ctx.attrs?.hostname
        ? `https://fly.io/apps/${ctx.attrs.appName}/certificates/${ctx.attrs.hostname}`
        : undefined,
    facts: (ctx) => [
      { label: "hostname", value: ctx.attrs?.hostname, copy: true },
      { label: "app", value: ctx.attrs?.appName },
      { label: "status", value: ctx.attrs?.status },
      { label: "configured", value: ctx.attrs?.configured },
      { label: "source", value: ctx.attrs?.source },
      { label: "acme requested", value: ctx.attrs?.acmeRequested },
    ],
  },
);

export const IpAssignmentUI = UIProvider.succeed<IpAssignment>(
  "Fly.IpAssignment",
  {
    displayName: "Fly IP Assignment",
    icon: "network",
    color: FLY_PURPLE,
    category: "network",
    summary: (ctx) => ctx.attrs?.ip,
    consoleUrl: (ctx) =>
      ctx.attrs?.appName
        ? `https://fly.io/apps/${ctx.attrs.appName}`
        : undefined,
    facts: (ctx) => [
      { label: "address", value: ctx.attrs?.ip, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "app", value: ctx.attrs?.appName },
      { label: "region", value: ctx.attrs?.region },
      { label: "shared", value: ctx.attrs?.shared },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const MachineUI = UIProvider.succeed<Machine>("Fly.Machine", {
  displayName: "Fly Machine",
  icon: "server",
  color: FLY_PURPLE,
  category: "compute",
  summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.machineId,
  link: (ctx) => ctx.attrs?.url,
  consoleUrl: (ctx) =>
    ctx.attrs?.appName && ctx.attrs?.machineId
      ? `https://fly.io/apps/${ctx.attrs.appName}/machines/${ctx.attrs.machineId}`
      : undefined,
  facts: (ctx) => [
    {
      label: "machine id",
      value: ctx.attrs?.machineId,
      mono: true,
      copy: true,
    },
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "app", value: ctx.attrs?.appName },
    { label: "region", value: ctx.attrs?.region },
    { label: "state", value: ctx.attrs?.state },
    { label: "count", value: ctx.attrs?.count },
    {
      label: "image",
      value:
        ctx.attrs?.imageRef?.repository !== undefined
          ? `${ctx.attrs.imageRef.repository}${
              ctx.attrs.imageRef.tag !== undefined
                ? `:${ctx.attrs.imageRef.tag}`
                : ""
            }`
          : undefined,
      mono: true,
    },
  ],
});

export const PostgresUI = UIProvider.succeed<Postgres>("Fly.Postgres", {
  displayName: "Fly Postgres",
  icon: "database",
  color: FLY_PURPLE,
  category: "database",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "cluster", value: ctx.attrs?.name, copy: true },
    {
      label: "cluster id",
      value: ctx.attrs?.clusterId,
      mono: true,
      copy: true,
    },
    { label: "status", value: ctx.attrs?.status },
    { label: "region", value: ctx.attrs?.region },
    { label: "plan", value: ctx.attrs?.plan },
    { label: "org", value: ctx.attrs?.orgSlug },
    { label: "disk (gb)", value: ctx.attrs?.disk },
  ],
});

export const RedisUI = UIProvider.succeed<Redis>("Fly.Redis", {
  displayName: "Fly Redis",
  icon: "zap",
  color: FLY_PURPLE,
  category: "database",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "add-on id", value: ctx.attrs?.redisId, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "primary region", value: ctx.attrs?.primaryRegion },
    { label: "plan", value: ctx.attrs?.planName },
    {
      label: "read regions",
      value:
        ctx.attrs?.readRegions !== undefined && ctx.attrs.readRegions.length > 0
          ? ctx.attrs.readRegions.join(", ")
          : undefined,
    },
    { label: "eviction", value: ctx.attrs?.eviction },
  ],
});

export const SecretUI = UIProvider.succeed<Secret>("Fly.Secret", {
  displayName: "Fly Secret",
  icon: "lock",
  color: FLY_PURPLE,
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) =>
    ctx.attrs?.appName
      ? `https://fly.io/apps/${ctx.attrs.appName}/secrets`
      : undefined,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, mono: true, copy: true },
    { label: "app", value: ctx.attrs?.appName },
    { label: "digest", value: ctx.attrs?.digest, mono: true },
    { label: "created", value: ctx.attrs?.createdAt },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const SecretKeyUI = UIProvider.succeed<SecretKey>("Fly.SecretKey", {
  displayName: "Fly Secret Key",
  icon: "key",
  color: FLY_PURPLE,
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) =>
    ctx.attrs?.appName ? `https://fly.io/apps/${ctx.attrs.appName}` : undefined,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, mono: true, copy: true },
    { label: "app", value: ctx.attrs?.appName },
    { label: "type", value: ctx.attrs?.type },
    {
      label: "public key",
      value: ctx.attrs?.publicKey,
      mono: true,
      copy: true,
    },
    { label: "created", value: ctx.attrs?.createdAt },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const ServiceUI = UIProvider.succeed<Service>("Fly.Service", {
  displayName: "Fly Service",
  icon: "cpu",
  color: FLY_PURPLE,
  category: "compute",
  summary: (ctx) => ctx.attrs?.name,
  link: (ctx) => ctx.attrs?.url,
  consoleUrl: (ctx) =>
    ctx.attrs?.appName && ctx.attrs?.machineId
      ? `https://fly.io/apps/${ctx.attrs.appName}/machines/${ctx.attrs.machineId}`
      : undefined,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "app", value: ctx.attrs?.appName },
    {
      label: "machine id",
      value: ctx.attrs?.machineId,
      mono: true,
      copy: true,
    },
    { label: "region", value: ctx.attrs?.region },
    { label: "state", value: ctx.attrs?.state },
    { label: "count", value: ctx.attrs?.count },
    { label: "code hash", value: ctx.attrs?.code?.hash, mono: true },
  ],
});

export const SpriteUI = UIProvider.succeed<Sprite>("Fly.Sprite", {
  displayName: "Fly Sprite",
  icon: "box",
  color: FLY_PURPLE,
  category: "compute",
  summary: (ctx) => ctx.attrs?.name,
  link: (ctx) => ctx.attrs?.url,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "sprite id", value: ctx.attrs?.spriteId, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "url auth", value: ctx.attrs?.urlAuth },
    { label: "org", value: ctx.attrs?.orgSlug },
    { label: "url", value: ctx.attrs?.url, href: ctx.attrs?.url },
    { label: "code hash", value: ctx.attrs?.code?.hash, mono: true },
  ],
});

export const VolumeSnapshotUI = UIProvider.succeed<VolumeSnapshot>(
  "Fly.VolumeSnapshot",
  {
    displayName: "Fly Volume Snapshot",
    icon: "camera",
    color: FLY_PURPLE,
    category: "storage",
    summary: (ctx) => ctx.attrs?.snapshotId,
    consoleUrl: (ctx) =>
      ctx.attrs?.appName
        ? `https://fly.io/apps/${ctx.attrs.appName}/volumes`
        : undefined,
    facts: (ctx) => [
      {
        label: "snapshot id",
        value: ctx.attrs?.snapshotId,
        mono: true,
        copy: true,
      },
      {
        label: "volume id",
        value: ctx.attrs?.volumeId,
        mono: true,
        copy: true,
      },
      { label: "app", value: ctx.attrs?.appName },
      { label: "status", value: ctx.attrs?.status },
      { label: "size (bytes)", value: ctx.attrs?.size },
      { label: "retention (days)", value: ctx.attrs?.retentionDays },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const AssetDeploymentUI = UIProvider.succeed<AssetDeployment>(
  "Fly.Website.AssetDeployment",
  {
    displayName: "Fly Website Assets",
    icon: "globe",
    color: FLY_PURPLE,
    category: "cdn",
    summary: (ctx) => ctx.attrs?.bucketName,
    facts: (ctx) => [
      { label: "bucket", value: ctx.attrs?.bucketName, copy: true },
      { label: "prefix", value: ctx.attrs?.prefix, mono: true },
      { label: "version", value: ctx.attrs?.version, mono: true, copy: true },
      { label: "files", value: ctx.attrs?.fileCount },
      { label: "source", value: ctx.props?.sourcePath, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    AppUI,
    BucketUI,
    CertificateUI,
    IpAssignmentUI,
    MachineUI,
    PostgresUI,
    RedisUI,
    SecretUI,
    SecretKeyUI,
    ServiceUI,
    SpriteUI,
    VolumeSnapshotUI,
    AssetDeploymentUI,
  );
