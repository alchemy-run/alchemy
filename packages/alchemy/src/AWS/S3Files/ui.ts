import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccessPoint } from "./AccessPoint.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Dashboard UI providers for AWS S3 Files resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** S3 Files brand color (AWS Storage green). */
const S3FILES_COLOR = "#7AA116";

export const FileSystemUI = UIProvider.succeed<FileSystem>(
  "AWS.S3Files.FileSystem",
  {
    displayName: "S3 File System",
    icon: "hard-drive",
    color: S3FILES_COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.fileSystemId,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.fileSystemId, mono: true, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.fileSystemArn,
        mono: true,
        copy: true,
      },
      { label: "bucket", value: ctx.attrs?.bucket, copy: true },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "prefix", value: ctx.attrs?.prefix, mono: true },
    ],
  },
);

export const AccessPointUI = UIProvider.succeed<AccessPoint>(
  "AWS.S3Files.AccessPoint",
  {
    displayName: "S3 Files Access Point",
    icon: "key-round",
    color: S3FILES_COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.accessPointId,
    facts: (ctx) => [
      {
        label: "id",
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
      { label: "file system", value: ctx.attrs?.fileSystemId, mono: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () => Layer.mergeAll(FileSystemUI, AccessPointUI);
