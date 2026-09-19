import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  eachContainer,
  encodeOwnership,
  expandContainer,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  listWorkspacesAt,
  ownedByAlchemy,
  parseOwnership,
  parsePath,
  retryConflict,
  sameText,
  TagmanagerNotResolved,
  toDisplayName,
  workspacePath,
} from "./internal.ts";

export type ContainersWorkspaceProps = {
  /**
   * Parent container path
   * (`accounts/{account}/containers/{container}`) or container id when
   * `account` is also set. Immutable — changing it replaces the
   * workspace.
   */
  container: string;
  /**
   * Account path or id used when `container` is an id. Immutable —
   * changing it replaces the workspace.
   */
  account?: string;
  /**
   * GTM workspace id. Server-assigned when omitted. Immutable — changing
   * it replaces the workspace.
   */
  workspaceId?: string;
  /**
   * Workspace display name. Generated when omitted.
   */
  name?: string;
  /**
   * Workspace description. GTM workspaces have no labels field, so
   * Alchemy stamps ownership here and strips it from attributes.
   */
  description?: string;
};

export type ContainersWorkspace = Resource<
  "GCP.Tagmanager.ContainersWorkspace",
  ContainersWorkspaceProps,
  {
    /** GTM API path `.../containers/{container}/workspaces/{workspace}`. */
    path: string;
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
    /** User display name. */
    name: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Tag Manager UI URL. */
    tagManagerUrl: string | undefined;
    /** Storage fingerprint used for optimistic updates. */
    fingerprint: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tag Manager workspace.
 *
 * Alchemy stamps ownership into `description` so `list` / nuke can find
 * the workspace. Parent container and id are immutable. Display name and
 * description update in place. The container's Default Workspace is left
 * alone unless it already carries an Alchemy marker.
 *
 * ### Creating a Workspace
 * **Example:** Feature workspace
 * ```typescript
 * const workspace = yield* GCP.Tagmanager.ContainersWorkspace("Feature", {
 *   container: container.path,
 *   name: "feature",
 *   description: "experiment tags",
 * });
 * ```
 *
 * ### Updating a Workspace
 * **Example:** Rename
 * ```typescript
 * const workspace = yield* GCP.Tagmanager.ContainersWorkspace("Feature", {
 *   container: existing.container,
 *   workspaceId: existing.workspaceId,
 *   name: "feature-v2",
 *   description: "experiment tags v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const ContainersWorkspace = Resource<ContainersWorkspace>(
  "GCP.Tagmanager.ContainersWorkspace",
);

export class ContainersWorkspaceNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainersWorkspaceNotResolved",
)<{
  path: string;
}> {}

const toAttrs = (workspace: tagmanager.Workspace, containerHint?: string) => {
  const path = workspace.path ?? "";
  const parsed = parsePath(path);
  return {
    path,
    container: parsed.container || containerHint || "",
    account: parsed.account,
    accountId: workspace.accountId ?? parsed.accountId ?? "",
    containerId: workspace.containerId ?? parsed.containerId ?? "",
    workspaceId:
      workspace.workspaceId ?? parsed.workspaceId ?? lastSegment(path),
    name: workspace.name,
    description: parseOwnership(workspace.description).text,
    tagManagerUrl: workspace.tagManagerUrl,
    fingerprint: workspace.fingerprint,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainersWorkspaces({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  container: string,
  id: string,
  name: string | undefined,
  description: string | undefined,
) =>
  listWorkspacesAt(container).pipe(
    Effect.flatMap((workspaces) =>
      Effect.gen(function* () {
        for (const workspace of workspaces) {
          if (
            description !== undefined &&
            workspace.description === description
          ) {
            return workspace;
          }
          if (
            name !== undefined &&
            workspace.name === name &&
            (yield* ownedByAlchemy(id, workspace.description))
          ) {
            return workspace;
          }
          if (yield* ownedByAlchemy(id, workspace.description)) {
            return workspace;
          }
        }
        return undefined;
      }),
    ),
  );

export const ContainersWorkspaceProvider = () =>
  Provider.succeed(ContainersWorkspace, {
    stables: [
      "path",
      "container",
      "account",
      "accountId",
      "containerId",
      "workspaceId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousContainer = olds?.container ?? output?.container;
      if (
        previousContainer !== undefined &&
        expandContainer(news.container, news.account) !==
          expandContainer(previousContainer)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.workspaceId ?? output?.workspaceId;
      if (
        previousId !== undefined &&
        news.workspaceId !== undefined &&
        news.workspaceId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const container = expandContainer(
        olds?.container ?? output?.container ?? "",
        olds?.account ?? output?.account,
      );
      const path =
        output?.path ??
        (olds?.workspaceId && container
          ? workspacePath(container, olds.workspaceId)
          : "");
      let existing = yield* getByPath(path);
      if (existing === undefined && container.length > 0) {
        existing = yield* findOwned(container, id, olds?.name, undefined);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, container);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      eachContainer((container) =>
        listWorkspacesAt(container).pipe(
          Effect.map((workspaces) =>
            workspaces
              .filter((workspace) => hasOwnershipMarker(workspace.description))
              .map((workspace) => toAttrs(workspace, container)),
          ),
        ),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const container = expandContainer(news.container, news.account);
      const path =
        output?.path ??
        (news.workspaceId ? workspacePath(container, news.workspaceId) : "");
      const ownership = yield* internalLabels(id);
      const name = yield* toDisplayName(id, news.name, output?.name);
      const description = encodeOwnership(ownership, news.description);

      let current = yield* getByPath(output?.path ?? path);
      if (current === undefined) {
        current = yield* findOwned(container, id, name, description);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainersWorkspaces({
            parent: container,
            body: { name, description },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(container, id, name, description),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContainersWorkspaceNotResolved({
          path: path || `${container}/workspaces/-`,
        });
      }

      if (!(yield* ownedByAlchemy(id, current.description))) {
        return yield* new TagmanagerNotResolved({
          path: current.path ?? path,
        });
      }

      const currentPath = current.path ?? path;
      const nameChanged = !sameText(current.name, name);
      const descriptionChanged = !sameText(current.description, description);

      if (nameChanged || descriptionChanged) {
        const updated = yield* retryConflict(
          Effect.gen(function* () {
            const fresh = yield* getByPath(currentPath);
            if (fresh === undefined) return undefined;
            return yield* tagmanager.updateAccountsContainersWorkspaces({
              path: currentPath,
              fingerprint: fresh.fingerprint,
              body: {
                path: currentPath,
                accountId: fresh.accountId,
                containerId: fresh.containerId,
                workspaceId: fresh.workspaceId,
                name,
                description,
              },
            });
          }),
        );
        current = updated ?? current;
      }

      return toAttrs(current, container);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* tagmanager
        .deleteAccountsContainersWorkspaces({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
