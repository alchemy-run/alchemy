import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccessPoint } from "./AccessPoint.ts";
import type { FileSystem } from "./FileSystem.ts";
import type { MountTarget } from "./MountTarget.ts";

/**
 * Dashboard UI providers for AWS EFS resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#7AA116";

export const FileSystemUI = UIProvider.succeed<FileSystem>(
  "AWS.EFS.FileSystem",
  {
    displayName: "EFS File System",
    icon: "hard-drive",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.fileSystemId,
    facts: (ctx) => [
      {
        label: "file system",
        value: ctx.attrs?.fileSystemId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.fileSystemArn,
        mono: true,
        copy: true,
      },
      { label: "performance mode", value: ctx.props?.performanceMode },
      { label: "throughput mode", value: ctx.props?.throughputMode },
      { label: "encrypted", value: ctx.props?.encrypted },
    ],
  },
);

export const AccessPointUI = UIProvider.succeed<AccessPoint>(
  "AWS.EFS.AccessPoint",
  {
    displayName: "EFS Access Point",
    icon: "key-round",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.accessPointId,
    facts: (ctx) => [
      {
        label: "access point",
        value: ctx.attrs?.accessPointId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.accessPointArn,
        mono: true,
        copy: true,
      },
      {
        label: "file system",
        value: ctx.attrs?.fileSystemId,
        mono: true,
      },
      { label: "path", value: ctx.props?.rootDirectory?.path, mono: true },
    ],
  },
);

export const MountTargetUI = UIProvider.succeed<MountTarget>(
  "AWS.EFS.MountTarget",
  {
    displayName: "EFS Mount Target",
    icon: "network",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.ipAddress ?? ctx.attrs?.mountTargetId,
    facts: (ctx) => [
      {
        label: "mount target",
        value: ctx.attrs?.mountTargetId,
        mono: true,
        copy: true,
      },
      {
        label: "file system",
        value: ctx.attrs?.fileSystemId,
        mono: true,
      },
      { label: "subnet", value: ctx.attrs?.subnetId, mono: true },
      { label: "ip address", value: ctx.attrs?.ipAddress, mono: true },
      {
        label: "availability zone",
        value: ctx.attrs?.availabilityZoneName,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(FileSystemUI, AccessPointUI, MountTargetUI);
