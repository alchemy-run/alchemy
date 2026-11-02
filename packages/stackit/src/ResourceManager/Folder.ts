import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredLabels, hasAlchemyLabels, isAlchemyOwned, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  containerName,
  desiredParent,
  isParent,
  labelsUpdate,
  listChildFolders,
  listFolderTree,
} from "./internal.ts";

/** A member granted a role on the folder when it is created. */
export interface FolderMember {
  /** Role on the folder, e.g. `owner`, `editor` or `reader`. */
  role: string;
  /** The member: a user's e-mail address, or a service account's e-mail. */
  subject: string;
}

export type FolderProps = {
  /**
   * Folder name. 2-41 characters (letters, digits, `_`, `+`, `&`, `-`, single
   * spaces), starting with a letter or digit. Renaming updates the folder in
   * place. If omitted, a unique name is generated from the stack, stage and
   * logical id.
   */
  name?: string;
  /**
   * Container id (or UUID) of the parent: an organization or another folder.
   * Changing it moves the folder, with everything in it, in place.
   * Defaults to the profile's organization.
   */
  parentId?: string;
  /**
   * Initial members of the folder. Only used when the folder is created;
   * changing it later has no effect on the folder.
   */
  members?: FolderMember[];
  /**
   * User labels (`key: value`). Keys are 1-63 characters (letters, digits,
   * `-`, `_`, `.`, optionally prefixed by a DNS subdomain and `/`); values
   * at most 63 characters. Alchemy ownership labels (`alchemy.*`) are merged
   * in automatically.
   */
  labels?: Record<string, string>;
};

export type Folder = Resource<
  "Stackit.ResourceManager.Folder",
  FolderProps,
  {
    /** Folder UUID. */
    folderId: string;
    /**
     * Globally unique, user-friendly folder id. Pass it as `parentId` to
     * place projects or folders inside this folder.
     */
    containerId: string;
    /** Folder name. */
    name: string;
    /** Container id of the parent organization or folder. */
    parentId: string;
    /** Type of the parent container. */
    parentType: resourceManager.ParentType;
    /** Folder labels, without Alchemy's ownership labels. */
    labels: Record<string, string>;
    /** RFC 3339 creation timestamp. */
    creationTime: string;
  },
  never,
  Providers
>;

/**
 * A STACKIT folder: groups projects (and other folders) inside an
 * organization, so permissions and organization policies can be applied to
 * all of them at once.
 *
 * Creating a folder needs organization-level permissions on the parent.
 * A folder can only be deleted once it is empty; Alchemy deletes the
 * projects and folders a stack places inside it first, and retries briefly
 * while their asynchronous deletion finishes.
 *
 * Ownership is marked with `alchemy.stack` / `alchemy.stage` / `alchemy.id`
 * labels; `alchemy unsafe nuke` only deletes folders carrying them.
 *
 * See [STACKIT's Resource Manager docs](https://docs.stackit.cloud/platform/resource-manager/).
 *
 * ### Creating a folder
 * **Example:** Folder in the profile's organization
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const folder = yield* Stackit.ResourceManager.Folder("Payments", {});
 * ```
 *
 * **Example:** Named folder with labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const folder = yield* Stackit.ResourceManager.Folder("Payments", {
 *   name: "payments",
 *   labels: { costCenter: "cc-1234" },
 * });
 * ```
 *
 * ### Nesting folders and projects
 * **Example:** A folder hierarchy with a project at the bottom
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const team = yield* Stackit.ResourceManager.Folder("Team", {});
 * const env = yield* Stackit.ResourceManager.Folder("Prod", {
 *   parentId: team.containerId,
 * });
 * const project = yield* Stackit.ResourceManager.Project("App", {
 *   parentId: env.containerId,
 *   owner: "jane.doe@example.com",
 * });
 * ```
 *
 * Changing `parentId` moves the folder and everything in it; nothing is
 * recreated.
 *
 * @resource
 * @product STACKIT Resource Manager
 * @category Resource Manager
 */
export const Folder = Resource<Folder>("Stackit.ResourceManager.Folder");

type ObservedFolder =
  | resourceManager.FolderResponse
  | resourceManager.GetFolderDetailsResponse
  | resourceManager.ListFoldersResponseItemsItem;

const toAttrs = (folder: ObservedFolder) => ({
  folderId: folder.folderId,
  containerId: folder.containerId,
  name: folder.name,
  parentId: folder.parent.containerId,
  parentType: folder.parent.type,
  labels: stripInternalLabels(folder.labels),
  creationTime: folder.creationTime,
});

const getFolder = (containerId: string) =>
  resourceManager
    .getFolderDetails({ containerId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** The Alchemy-owned folder for logical id `id` under `parentId`, if any. */
const findOwned = Effect.fn(function* (id: string, parentId: string) {
  for (const folder of yield* listChildFolders(parentId)) {
    if (yield* hasAlchemyLabels(id, folder.labels)) return folder;
  }
  return undefined;
});

export const FolderProvider = () =>
  Provider.succeed(Folder, {
    stables: ["folderId", "containerId", "creationTime"],

    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.containerId !== undefined) {
        const byId = yield* getFolder(output.containerId);
        return byId === undefined ? undefined : toAttrs(byId);
      }
      const parentId = yield* desiredParent(olds?.parentId);
      const owned = yield* findOwned(id, parentId);
      if (owned !== undefined) return toAttrs(owned);
      // A same-named folder without our labels: report it, but as foreign.
      if (olds?.name === undefined) return undefined;
      const children = yield* listChildFolders(parentId);
      const named = children.find((folder) => folder.name === olds.name);
      return named === undefined ? undefined : Unowned(toAttrs(named));
    }),

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      // A profile without an organization has nothing in scope to enumerate.
      const organizationId = env.organizationId;
      if (organizationId === undefined) return [];
      const folders = yield* listFolderTree(organizationId);
      return folders.filter((folder) => isAlchemyOwned(folder.labels)).map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* containerName(id, news.name);
      const parentId = yield* desiredParent(news.parentId);
      const labels = yield* desiredLabels(id, news.labels);

      // 1. Observe: by the cached id, then by ownership labels under the parent.
      let current: ObservedFolder | undefined =
        output?.containerId === undefined ? undefined : yield* getFolder(output.containerId);
      if (current === undefined) current = yield* findOwned(id, parentId);

      // 2. Ensure
      if (current === undefined) {
        const created = yield* resourceManager.createFolder({
          containerParentId: parentId,
          name,
          labels,
          members: news.members !== undefined && news.members.length > 0 ? news.members : undefined,
        });
        // Creation is synchronous, but reads can lag briefly behind it.
        current = yield* waitFor({
          resource: `STACKIT folder ${name}`,
          read: getFolder(created.containerId),
          ready: (folder) => folder !== undefined,
          state: (folder) => (folder === undefined ? "not visible" : "visible"),
          timeout: "1 minute",
        }).pipe(Effect.map((folder) => folder ?? created));
      }

      // 3. Sync name, parent and labels against the observed folder.
      const labelPatch = labelsUpdate(current.labels, labels);
      const rename = current.name !== name;
      const move = !isParent(current.parent, parentId);
      if (rename || move || labelPatch !== undefined) {
        current = yield* resourceManager.partialUpdateFolder({
          containerId: current.containerId,
          name: rename ? name : undefined,
          containerParentId: move ? parentId : undefined,
          labels: labelPatch,
        });
      }

      // 4. Return
      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const current = yield* getFolder(output.containerId);
      if (current === undefined) return;
      yield* resourceManager.deleteFolder({ containerId: output.containerId }).pipe(
        // 409 while the folder still has children, e.g. a project whose
        // asynchronous deletion has not finished yet. Bounded (~50s); a folder
        // with children Alchemy does not manage fails loudly.
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          schedule: Schedule.spaced("5 seconds"),
          times: 10,
        }),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone({
        resource: `STACKIT folder ${output.containerId}`,
        read: getFolder(output.containerId),
        timeout: "5 minutes",
        interval: "2 seconds",
        maxInterval: "15 seconds",
      });
    }),
  });
