import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  eachWorkspace,
  encodeOwnership,
  resolveWorkspace,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  listFoldersAt,
  ownedByAlchemy,
  parseOwnership,
  parsePath,
  retryConflict,
  sameText,
  TagmanagerNotResolved,
  toDisplayName,
} from "./internal.ts";

export type ContainersWorkspacesFolderProps = {
  /**
   * Parent workspace path
   * (`accounts/{account}/containers/{container}/workspaces/{workspace}`)
   * or workspace id when `container` is also set. Immutable — changing
   * it replaces the folder.
   */
  workspace: string;
  /**
   * Parent container path used when `workspace` is an id. Immutable —
   * changing it replaces the folder.
   */
  container?: string;
  /**
   * GTM folder id. Server-assigned when omitted. Immutable — changing it
   * replaces the folder.
   */
  folderId?: string;
  /**
   * Folder display name. Generated when omitted.
   */
  name?: string;
  /**
   * Folder notes. Alchemy stamps ownership here and strips it from
   * attributes.
   */
  notes?: string;
};

export type ContainersWorkspacesFolder = Resource<
  "GCP.Tagmanager.ContainersWorkspacesFolder",
  ContainersWorkspacesFolderProps,
  {
    /** GTM API path `.../workspaces/{workspace}/folders/{folder}`. */
    path: string;
    /** Parent workspace path. */
    workspace: string;
    /** Parent container path. */
    container: string;
    /** Parent account path. */
    account: string;
    /** GTM account id. */
    accountId: string;
    /** GTM container id. */
    containerId: string;
    /** GTM workspace id. */
    workspaceId: string;
    /** GTM folder id. */
    folderId: string;
    /** User display name. */
    name: string | undefined;
    /** User notes with the Alchemy ownership prefix stripped. */
    notes: string | undefined;
    /** Tag Manager UI URL. */
    tagManagerUrl: string | undefined;
    /** Storage fingerprint used for optimistic updates. */
    fingerprint: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tag Manager folder inside a workspace.
 *
 * Alchemy stamps ownership into `notes` so `list` / nuke can find the
 * folder. Parent workspace and id are immutable. Display name and notes
 * update in place.
 *
 * ### Creating a Folder
 * **Example:** Analytics folder
 * ```typescript
 * const folder = yield* GCP.Tagmanager.ContainersWorkspacesFolder("Analytics", {
 *   workspace: workspace.path,
 *   name: "analytics",
 *   notes: "measurement tags",
 * });
 * ```
 *
 * ### Updating a Folder
 * **Example:** Rename
 * ```typescript
 * const folder = yield* GCP.Tagmanager.ContainersWorkspacesFolder("Analytics", {
 *   workspace: existing.workspace,
 *   folderId: existing.folderId,
 *   name: "analytics-v2",
 *   notes: "measurement tags v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const ContainersWorkspacesFolder = Resource<ContainersWorkspacesFolder>(
  "GCP.Tagmanager.ContainersWorkspacesFolder",
);

export class ContainersWorkspacesFolderNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainersWorkspacesFolderNotResolved",
)<{
  path: string;
}> {}

const toAttrs = (folder: tagmanager.Folder, workspaceHint?: string) => {
  const path = folder.path ?? "";
  const parsed = parsePath(path);
  return {
    path,
    workspace: parsed.workspace || workspaceHint || "",
    container: parsed.container,
    account: parsed.account,
    accountId: folder.accountId ?? parsed.accountId ?? "",
    containerId: folder.containerId ?? parsed.containerId ?? "",
    workspaceId: folder.workspaceId ?? parsed.workspaceId ?? "",
    folderId: folder.folderId ?? parsed.folderId ?? lastSegment(path),
    name: folder.name,
    notes: parseOwnership(folder.notes).text,
    tagManagerUrl: folder.tagManagerUrl,
    fingerprint: folder.fingerprint,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainersWorkspacesFolders({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  workspace: string,
  id: string,
  name: string | undefined,
  notes: string | undefined,
) =>
  listFoldersAt(workspace).pipe(
    Effect.flatMap((folders) =>
      Effect.gen(function* () {
        for (const folder of folders) {
          if (notes !== undefined && folder.notes === notes) return folder;
          if (
            name !== undefined &&
            folder.name === name &&
            (yield* ownedByAlchemy(id, folder.notes))
          ) {
            return folder;
          }
          if (yield* ownedByAlchemy(id, folder.notes)) return folder;
        }
        return undefined;
      }),
    ),
  );

export const ContainersWorkspacesFolderProvider = () =>
  Provider.succeed(ContainersWorkspacesFolder, {
    stables: [
      "path",
      "workspace",
      "container",
      "account",
      "accountId",
      "containerId",
      "workspaceId",
      "folderId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousWorkspace = olds?.workspace ?? output?.workspace;
      if (
        previousWorkspace !== undefined &&
        resolveWorkspace(news.workspace, news.container) !==
          resolveWorkspace(previousWorkspace)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.folderId ?? output?.folderId;
      if (
        previousId !== undefined &&
        news.folderId !== undefined &&
        news.folderId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const workspace = resolveWorkspace(
        olds?.workspace ?? output?.workspace ?? "",
        olds?.container ?? output?.container,
      );
      const path =
        output?.path ??
        (olds?.folderId && workspace
          ? `${workspace}/folders/${olds.folderId}`
          : "");
      let existing = yield* getByPath(path);
      if (existing === undefined && workspace.length > 0) {
        existing = yield* findOwned(workspace, id, olds?.name, undefined);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, workspace);
      return (yield* ownedByAlchemy(id, existing.notes))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      eachWorkspace((workspace) =>
        listFoldersAt(workspace).pipe(
          Effect.map((folders) =>
            folders
              .filter((folder) => hasOwnershipMarker(folder.notes))
              .map((folder) => toAttrs(folder, workspace)),
          ),
        ),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const workspace = resolveWorkspace(news.workspace, news.container);
      const path =
        output?.path ??
        (news.folderId ? `${workspace}/folders/${news.folderId}` : "");
      const ownership = yield* internalLabels(id);
      const name = yield* toDisplayName(id, news.name, output?.name);
      const notes = encodeOwnership(ownership, news.notes);

      let current = yield* getByPath(output?.path ?? path);
      if (current === undefined) {
        current = yield* findOwned(workspace, id, name, notes);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainersWorkspacesFolders({
            parent: workspace,
            body: { name, notes },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(workspace, id, name, notes),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContainersWorkspacesFolderNotResolved({
          path: path || `${workspace}/folders/-`,
        });
      }

      if (!(yield* ownedByAlchemy(id, current.notes))) {
        return yield* new TagmanagerNotResolved({
          path: current.path ?? path,
        });
      }

      const currentPath = current.path ?? path;
      const nameChanged = !sameText(current.name, name);
      const notesChanged = !sameText(current.notes, notes);

      if (nameChanged || notesChanged) {
        const updated = yield* retryConflict(
          Effect.gen(function* () {
            const fresh = yield* getByPath(currentPath);
            if (fresh === undefined) return undefined;
            return yield* tagmanager.updateAccountsContainersWorkspacesFolders({
              path: currentPath,
              fingerprint: fresh.fingerprint,
              body: {
                path: currentPath,
                accountId: fresh.accountId,
                containerId: fresh.containerId,
                workspaceId: fresh.workspaceId,
                folderId: fresh.folderId,
                name,
                notes,
              },
            });
          }),
        );
        current = updated ?? current;
      }

      return toAttrs(current, workspace);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* tagmanager
        .deleteAccountsContainersWorkspacesFolders({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
