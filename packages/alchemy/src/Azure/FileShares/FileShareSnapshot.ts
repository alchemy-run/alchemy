import * as fileshares from "@distilled.cloud/azure/fileshares";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags, tagRecord } from "../../Tags.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  tagsDiffer,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createFileShareName } from "./FileShareNames.ts";

export interface FileShareSnapshotProps {
  /** Resource group of the file share. Changing it replaces the snapshot. */
  resourceGroup: string;
  /** Resource name of the file share. Changing it replaces the snapshot. */
  fileShare: string;
  /**
   * Snapshot name: 3-63 lowercase letters, digits, and hyphens. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the snapshot.
   */
  name?: string;
  /**
   * User-defined initiator recorded on the snapshot. Only applied when the
   * snapshot is taken; changing it replaces the snapshot.
   */
  initiatorId?: string;
  /**
   * User metadata. Alchemy ownership markers (`alchemy_stack`,
   * `alchemy_stage`, `alchemy_id`) are merged in because snapshots have no
   * tags.
   */
  metadata?: Record<string, string>;
}

export interface FileShareSnapshot extends Resource<
  "Azure.FileShares.FileShareSnapshot",
  FileShareSnapshotProps,
  {
    /** Name of the snapshot. */
    snapshotName: string;
    /** ARM resource ID of the snapshot. */
    snapshotId: string;
    /** Resource name of the file share. */
    fileShare: string;
    /** Resource group of the file share. */
    resourceGroup: string;
    /** Point in time (UTC) the snapshot captured. */
    snapshotTime: string | undefined;
    /** User-defined initiator recorded on the snapshot. */
    initiatorId: string | undefined;
    /** User metadata (Alchemy ownership markers stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A point-in-time, read-only snapshot of a `Microsoft.FileShares` file
 * share. Snapshots are differential: they are billed only for data that
 * changed since the snapshot was taken.
 *
 * Snapshots cannot be tagged, so Alchemy records ownership in snapshot
 * metadata (`alchemy_stack`, `alchemy_stage`, `alchemy_id`). A share
 * cannot be deleted while it has snapshots; Alchemy deletes the snapshot
 * before its share.
 *
 * @see https://learn.microsoft.com/azure/storage/files/storage-snapshots-files
 *
 * ### Taking a Snapshot
 * **Example:** Snapshot a file share
 * ```typescript
 * const share = yield* Azure.FileShares.FileShare("data", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const snapshot = yield* Azure.FileShares.FileShareSnapshot("before-migration", {
 *   resourceGroup: group.resourceGroupName,
 *   fileShare: share.fileShareName,
 * });
 * ```
 *
 * **Example:** Snapshot with metadata
 * ```typescript
 * const snapshot = yield* Azure.FileShares.FileShareSnapshot("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   fileShare: share.fileShareName,
 *   initiatorId: "release-pipeline",
 *   metadata: { reason: "release" },
 * });
 * ```
 *
 * @resource
 */
export const FileShareSnapshot = Resource<FileShareSnapshot>(
  "Azure.FileShares.FileShareSnapshot",
);

/** Metadata keys must be identifiers, so `alchemy::x` becomes `alchemy_x`. */
const ownershipMetadata = Effect.fn(function* (id: string) {
  const tags = yield* createInternalTags(id);
  return Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [
      key.replace(/^alchemy::/, "alchemy_"),
      value,
    ]),
  );
});

const userMetadata = (
  metadata: Record<string, string | undefined> | undefined,
) =>
  Object.fromEntries(
    Object.entries(tagRecord(metadata)).filter(
      ([key]) => !key.startsWith("alchemy_"),
    ),
  );

const isOwnedByMetadata = (
  id: string,
  metadata: Record<string, string | undefined> | undefined,
) =>
  hasAlchemyTags(
    id,
    Object.fromEntries(
      Object.entries(tagRecord(metadata)).map(([key, value]) => [
        key.replace(/^alchemy_/, "alchemy::"),
        value,
      ]),
    ),
  );

const getSnapshot = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    fileshares.GetFileShareSnapshot({
      subscriptionId,
      resourceGroupName,
      resourceName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  fileShare: string,
  name: string,
  snapshot: fileshares.GetFileShareSnapshotResponse,
): FileShareSnapshot["Attributes"] => ({
  snapshotName: name,
  snapshotId: snapshot.id ?? "",
  fileShare,
  resourceGroup,
  snapshotTime: snapshot.properties?.snapshotTime,
  initiatorId: snapshot.properties?.initiatorId,
  metadata: userMetadata(snapshot.properties?.metadata),
});

export const FileShareSnapshotProvider = () =>
  Provider.succeed(FileShareSnapshot, {
    stables: [
      "snapshotName",
      "snapshotId",
      "fileShare",
      "resourceGroup",
      "snapshotTime",
      "initiatorId",
    ],

    // Snapshots live inside a file share; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.fileShare !== output.fileShare ||
        (news.name !== undefined && news.name !== output.snapshotName) ||
        (news.initiatorId !== undefined &&
          news.initiatorId !== output.initiatorId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const fileShare = output?.fileShare ?? olds?.fileShare;
      if (resourceGroup === undefined || fileShare === undefined) {
        return undefined;
      }
      const name =
        output?.snapshotName ?? olds?.name ?? (yield* createFileShareName(id));
      const observed = yield* getSnapshot(
        subscriptionId,
        resourceGroup,
        fileShare,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, fileShare, name, observed);
      return (yield* isOwnedByMetadata(id, observed.properties?.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.FileShares");
      const { resourceGroup, fileShare } = news;
      const name =
        news.name ?? output?.snapshotName ?? (yield* createFileShareName(id));
      const metadata = {
        ...news.metadata,
        ...(yield* ownershipMetadata(id)),
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: fileShare,
        name,
      };
      const get = getSnapshot(subscriptionId, resourceGroup, fileShare, name);
      const label = `file share snapshot ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation with an empty body.
      if (observed === undefined) {
        yield* fileshares.FileShareSnapshotCreateOrUpdate({
          ...where,
          properties: { initiatorId: news.initiatorId, metadata },
        });
      }
      observed = yield* waitForProvisioned(label, get, () => undefined, {
        interval: "3 seconds",
        times: 60,
      });

      // Sync metadata against the observed snapshot.
      if (tagsDiffer(observed.properties?.metadata, metadata)) {
        yield* fileshares.UpdateFileShareSnapshot({
          ...where,
          properties: { metadata },
        });
        observed = yield* waitForProvisioned(
          label,
          get.pipe(
            Effect.map((snapshot) =>
              snapshot !== undefined &&
              !tagsDiffer(snapshot.properties?.metadata, metadata)
                ? snapshot
                : undefined,
            ),
          ),
          () => undefined,
          { interval: "3 seconds", times: 40 },
        );
      }

      return toAttrs(resourceGroup, fileShare, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        fileshares.DeleteFileShareSnapshot({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.fileShare,
          name: output.snapshotName,
        }),
      );
      yield* waitUntilGone(
        `file share snapshot ${output.snapshotName}`,
        getSnapshot(
          subscriptionId,
          output.resourceGroup,
          output.fileShare,
          output.snapshotName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
