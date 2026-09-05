import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Dashboard UI providers for AWS FSx resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const FileSystemUI = UIProvider.succeed<FileSystem>(
  "AWS.FSx.FileSystem",
  {
    displayName: "FSx File System",
    icon: "hard-drive",
    color: "#7AA116",
    category: "storage",
    summary: (ctx) => ctx.attrs?.dnsName ?? ctx.attrs?.fileSystemId,
    facts: (ctx) => [
      {
        label: "file system id",
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
      { label: "type", value: ctx.attrs?.fileSystemType },
      { label: "dns name", value: ctx.attrs?.dnsName, mono: true },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      { label: "storage capacity (gib)", value: ctx.props?.storageCapacity },
    ],
  },
);

export const ui = () => Layer.mergeAll(FileSystemUI);
