import * as drive from "@distilled.cloud/gcp/drive_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { diffLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_MIME_TYPE,
  desiredFileProperties,
  encodeOwnership,
  fileOwnedByAlchemy,
  findOwnedFile,
  getFile,
  hasAlchemyFileMarker,
  ignoreMissing,
  listOwnedFiles,
  MAX_FILE_NAME_LENGTH,
  parseOwnership,
  sameBoolean,
  sameText,
  toGeneratedName,
  userProperties,
} from "./internal.ts";

export type FileProps = {
  /**
   * Drive-assigned file id. Server-assigned on create. Immutable —
   * changing it replaces the file.
   */
  fileId?: string;
  /**
   * Display name. If omitted, a unique name is generated from the stack,
   * stage, and logical id.
   */
  name?: string;
  /**
   * File description. Drive files stamp Alchemy ownership into
   * `properties` and a `[alchemy …]` prefix on description (stripped
   * from attributes).
   */
  description?: string;
  /**
   * MIME type. Immutable after create — changing it replaces the file.
   * @default "application/vnd.google-apps.document"
   */
  mimeType?: string;
  /**
   * Parent folder ids. Drive files have a single parent; extra ids are
   * ignored by the API.
   */
  parents?: string[];
  /**
   * Whether the user has starred the file.
   */
  starred?: boolean;
  /**
   * Whether the file is in the trash.
   */
  trashed?: boolean;
  /**
   * Whether writers can share the file. Not populated for items in
   * shared drives.
   */
  writersCanShare?: boolean;
  /**
   * Disable copy, print, and download for readers and commenters.
   */
  copyRequiresWriterPermission?: boolean;
  /**
   * Folder color as an RGB hex string.
   */
  folderColorRgb?: string;
  /**
   * Original filename of uploaded binary content.
   */
  originalFilename?: string;
  /**
   * User properties. Alchemy ownership properties are merged in
   * automatically.
   */
  properties?: Record<string, string>;
};

export type File = Resource<
  "GCP.Drive.File",
  FileProps,
  {
    /** Drive-assigned file id. */
    fileId: string;
    /** Project id used when the file was reconciled. */
    project: string;
    /** Display name. */
    name: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** MIME type. */
    mimeType: string | undefined;
    /** Parent folder ids. */
    parents: string[];
    /** Whether the file is starred. */
    starred: boolean;
    /** Whether the file is trashed. */
    trashed: boolean;
    /** Whether writers can share. */
    writersCanShare: boolean | undefined;
    /** Whether copy requires writer permission. */
    copyRequiresWriterPermission: boolean | undefined;
    /** Folder color. */
    folderColorRgb: string | undefined;
    /** Original filename. */
    originalFilename: string | undefined;
    /** User properties (Alchemy ownership properties stripped). */
    properties: Record<string, string>;
    /** Web view link. */
    webViewLink: string | undefined;
    /** Shared drive id, when the file lives in a shared drive. */
    driveId: string | undefined;
    /** Size in bytes, when populated. */
    size: string | undefined;
    /** RFC3339 creation timestamp. */
    createdTime: string | undefined;
    /** RFC3339 last-modified timestamp. */
    modifiedTime: string | undefined;
    /** Monotonic version number. */
    version: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Drive file or Google Docs Editors document.
 *
 * Drive files store Alchemy ownership in custom `properties` (and a
 * description prefix) so `list` / nuke can find them. The Drive id and
 * MIME type are identity — changing either replaces the file. Name,
 * description, parents, star, trash, sharing flags, and properties
 * update in place.
 *
 * ### Creating a File
 * **Example:** Generated Google Doc
 * ```typescript
 * const file = yield* GCP.Drive.File("Notes", {});
 * ```
 *
 * **Example:** Named document with properties
 * ```typescript
 * const file = yield* GCP.Drive.File("Notes", {
 *   name: "sprint-notes",
 *   description: "weekly notes",
 *   properties: { env: "test" },
 * });
 * ```
 *
 * ### Updating a File
 * **Example:** Rename and star
 * ```typescript
 * const file = yield* GCP.Drive.File("Notes", {
 *   fileId: existing.fileId,
 *   name: "sprint-notes-2026",
 *   starred: true,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Drive
 */
export const File = Resource<File>("GCP.Drive.File");

export class FileNotResolved extends Data.TaggedError(
  "GCP.Drive.FileNotResolved",
)<{
  fileId: string;
}> {}

const toAttrs = (file: drive.File, project: string) => ({
  fileId: file.id ?? "",
  project,
  name: file.name,
  description: parseOwnership(file.description).text,
  mimeType: file.mimeType,
  parents: file.parents ?? [],
  starred: file.starred === true,
  trashed: file.trashed === true,
  writersCanShare: file.writersCanShare,
  copyRequiresWriterPermission: file.copyRequiresWriterPermission,
  folderColorRgb: file.folderColorRgb,
  originalFilename: file.originalFilename,
  properties: userProperties(file.properties),
  webViewLink: file.webViewLink,
  driveId: file.driveId,
  size: file.size,
  createdTime: file.createdTime,
  modifiedTime: file.modifiedTime,
  version: file.version,
});

const refresh = (fileId: string, fallback: drive.File) =>
  getFile(fileId).pipe(Effect.map((fresh) => fresh ?? fallback));

export const FileProvider = () =>
  Provider.succeed(File, {
    stables: ["fileId", "project", "mimeType", "createdTime", "driveId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.fileId ?? output?.fileId;
      if (
        previousId !== undefined &&
        news.fileId !== undefined &&
        news.fileId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousMime = olds?.mimeType ?? output?.mimeType;
      const nextMime = news.mimeType ?? previousMime ?? DEFAULT_MIME_TYPE;
      if (previousMime !== undefined && nextMime !== previousMime) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const fileId = olds?.fileId ?? output?.fileId ?? "";
      let existing = yield* getFile(fileId);
      if (existing === undefined) {
        existing = yield* findOwnedFile(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* fileOwnedByAlchemy(id, existing)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const files = yield* listOwnedFiles();
        return files
          .filter(hasAlchemyFileMarker)
          .map((file) => toAttrs(file, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* desiredFileProperties(id, news.properties);
      const name = yield* toGeneratedName(
        id,
        news.name,
        output?.name,
        MAX_FILE_NAME_LENGTH,
      );
      const description = encodeOwnership(ownership, news.description);
      const mimeType = news.mimeType ?? output?.mimeType ?? DEFAULT_MIME_TYPE;
      const desired: drive.File = {
        name,
        description,
        mimeType,
        parents: news.parents,
        starred: news.starred,
        trashed: news.trashed,
        writersCanShare: news.writersCanShare,
        copyRequiresWriterPermission: news.copyRequiresWriterPermission,
        folderColorRgb: news.folderColorRgb,
        originalFilename: news.originalFilename,
        properties: ownership,
      };

      let current = yield* getFile(news.fileId ?? output?.fileId ?? "");
      if (current === undefined) {
        current = yield* findOwnedFile(id);
      }

      if (current === undefined) {
        const created = yield* drive
          .createFiles({
            supportsAllDrives: true,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => findOwnedFile(id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new FileNotResolved({
          fileId: news.fileId ?? output?.fileId ?? name,
        });
      }

      const fileId = current.id ?? news.fileId ?? output?.fileId ?? "";
      const { upsert, removed } = diffLabels(
        tagRecord(current.properties),
        ownership,
      );
      const propertiesChanged = upsert.length > 0 || removed.length > 0;
      const nameChanged = !sameText(current.name, name);
      const descriptionChanged = !sameText(current.description, description);
      const starredChanged =
        news.starred !== undefined &&
        !sameBoolean(current.starred, news.starred);
      const trashedChanged =
        news.trashed !== undefined &&
        !sameBoolean(current.trashed, news.trashed);
      const writersChanged =
        news.writersCanShare !== undefined &&
        !sameBoolean(current.writersCanShare, news.writersCanShare);
      const copyChanged =
        news.copyRequiresWriterPermission !== undefined &&
        !sameBoolean(
          current.copyRequiresWriterPermission,
          news.copyRequiresWriterPermission,
        );
      const colorChanged =
        news.folderColorRgb !== undefined &&
        !sameText(current.folderColorRgb, news.folderColorRgb);
      const originalChanged =
        news.originalFilename !== undefined &&
        !sameText(current.originalFilename, news.originalFilename);
      const currentParents = current.parents ?? [];
      const desiredParents = news.parents;
      const addParents =
        desiredParents !== undefined
          ? desiredParents.filter((parent) => !currentParents.includes(parent))
          : [];
      const removeParents =
        desiredParents !== undefined
          ? currentParents.filter((parent) => !desiredParents.includes(parent))
          : [];
      const parentsChanged = addParents.length > 0 || removeParents.length > 0;

      if (
        propertiesChanged ||
        nameChanged ||
        descriptionChanged ||
        starredChanged ||
        trashedChanged ||
        writersChanged ||
        copyChanged ||
        colorChanged ||
        originalChanged ||
        parentsChanged
      ) {
        const nextProperties: Record<string, string | undefined> = {
          ...ownership,
        };
        for (const key of removed) {
          nextProperties[key] = undefined;
        }
        current = yield* drive.updateFiles({
          fileId,
          supportsAllDrives: true,
          addParents: addParents.length > 0 ? addParents.join(",") : undefined,
          removeParents:
            removeParents.length > 0 ? removeParents.join(",") : undefined,
          body: {
            name,
            description,
            starred: news.starred,
            trashed: news.trashed,
            writersCanShare: news.writersCanShare,
            copyRequiresWriterPermission: news.copyRequiresWriterPermission,
            folderColorRgb: news.folderColorRgb,
            originalFilename: news.originalFilename,
            properties: nextProperties,
          },
        });
      }

      const fresh = yield* refresh(fileId, current);
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.fileId.length === 0) return;
      yield* ignoreMissing(
        drive.deleteFiles({
          fileId: output.fileId,
          supportsAllDrives: true,
        }),
      );
    }),
  });
