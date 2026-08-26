import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  encodeOwnershipLine,
  expandWorkspace,
  isOwnedEntity,
  lastSegment,
  listWorkspacePaths,
  ownedByAlchemy,
  ownershipLabels,
  parametersOf,
  parentOf,
  parseOwnership,
  resourcePath,
  retryConflict,
  sameJson,
  sameText,
  toDisplayName,
  type TagmanagerParameter,
  workspacePathOf,
} from "./internal.ts";

export type ContainersWorkspacesTransformationProps = {
  /**
   * Parent workspace path
   * `accounts/{account}/containers/{container}/workspaces/{workspace}`.
   * Transformations require a server-side container. Immutable —
   * changing it replaces the transformation.
   */
  workspace: string;
  /**
   * Server-assigned transformation id. Immutable — changing it replaces
   * the transformation.
   */
  transformationId?: string;
  /**
   * Display name unique within the workspace. Transformations have no
   * labels field, so Alchemy stamps ownership into `name` and `notes`.
   */
  name?: string;
  /**
   * Transformation type (server-side built-in or custom template id).
   */
  type: string;
  /**
   * User notes. Alchemy also stamps ownership here so `list` / nuke can
   * find the transformation.
   */
  notes?: string;
  /** Transformation parameters. */
  parameter?: TagmanagerParameter[];
  /** Parent folder id. */
  parentFolderId?: string;
};

export type ContainersWorkspacesTransformation = Resource<
  "GCP.Tagmanager.ContainersWorkspacesTransformation",
  ContainersWorkspacesTransformationProps,
  {
    /** GTM API relative path. */
    path: string;
    /** Transformation id. */
    transformationId: string;
    /** Parent workspace path. */
    workspace: string;
    /** Account id. */
    accountId: string | undefined;
    /** Container id. */
    containerId: string | undefined;
    /** Workspace id. */
    workspaceId: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Transformation type. */
    type: string | undefined;
    /** User notes with the Alchemy ownership prefix stripped. */
    notes: string | undefined;
    /** Transformation parameters. */
    parameter: TagmanagerParameter[] | undefined;
    /** Parent folder id. */
    parentFolderId: string | undefined;
    /** Storage fingerprint. */
    fingerprint: string | undefined;
    /** Tag Manager UI URL. */
    tagManagerUrl: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tag Manager transformation in a server-side container
 * workspace.
 *
 * Transformations have no labels field — Alchemy stamps ownership into
 * `name` and `notes` so `list` / nuke can find them. Parent workspace
 * and id are immutable. Display name, type, notes, and parameters
 * update in place.
 *
 * ### Creating a Transformation
 * **Example:** Named transformation
 * ```typescript
 * const transformation =
 *   yield* GCP.Tagmanager.ContainersWorkspacesTransformation("Allow", {
 *     workspace: serverWorkspacePath,
 *     type: "tf",
 *     notes: "allowlist event params",
 *   });
 * ```
 *
 * ### Updating a Transformation
 * **Example:** Change notes
 * ```typescript
 * const transformation =
 *   yield* GCP.Tagmanager.ContainersWorkspacesTransformation("Allow", {
 *     workspace: existing.workspace,
 *     transformationId: existing.transformationId,
 *     type: existing.type ?? "tf",
 *     notes: "updated allowlist",
 *   });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const ContainersWorkspacesTransformation =
  Resource<ContainersWorkspacesTransformation>(
    "GCP.Tagmanager.ContainersWorkspacesTransformation",
  );

export class ContainersWorkspacesTransformationNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainersWorkspacesTransformationNotResolved",
)<{
  path: string;
}> {}

const COLLECTION = "transformations";

const toAttrs = (
  transformation: tagmanager.Transformation,
  workspaceHint?: string,
) => {
  const path = transformation.path ?? "";
  return {
    path,
    transformationId: transformation.transformationId ?? lastSegment(path),
    workspace: path.includes("/transformations/")
      ? parentOf(path)
      : (workspaceHint ?? workspacePathOf(path)),
    accountId: transformation.accountId,
    containerId: transformation.containerId,
    workspaceId: transformation.workspaceId,
    name: parseOwnership(transformation.name).text,
    type: transformation.type,
    notes: parseOwnership(transformation.notes).text,
    parameter: parametersOf(transformation.parameter),
    parentFolderId: transformation.parentFolderId,
    fingerprint: transformation.fingerprint,
    tagManagerUrl: transformation.tagManagerUrl,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainersWorkspacesTransformations({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  tagmanager.listAccountsContainersWorkspacesTransformations
    .pages({ parent })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.transformation ?? [])),
      Stream.filter(isOwnedEntity),
      Stream.map((transformation) => toAttrs(transformation, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const findByName = (parent: string, name: string) =>
  tagmanager.listAccountsContainersWorkspacesTransformations
    .pages({ parent })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.transformation ?? [])),
      Stream.filter((transformation) => transformation.name === name),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
    );

export const ContainersWorkspacesTransformationProvider = () =>
  Provider.succeed(ContainersWorkspacesTransformation, {
    stables: [
      "path",
      "transformationId",
      "workspace",
      "accountId",
      "containerId",
      "workspaceId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousWorkspace = olds?.workspace ?? output?.workspace;
      if (
        previousWorkspace !== undefined &&
        expandWorkspace(news.workspace) !== expandWorkspace(previousWorkspace)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.transformationId ?? output?.transformationId;
      if (
        previousId !== undefined &&
        news.transformationId !== undefined &&
        news.transformationId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const workspace =
        olds?.workspace !== undefined
          ? expandWorkspace(olds.workspace)
          : output?.workspace;
      const path =
        output?.path ??
        (workspace !== undefined &&
        (olds?.transformationId ?? output?.transformationId) !== undefined
          ? resourcePath(
              workspace,
              COLLECTION,
              olds?.transformationId ?? output?.transformationId ?? "",
            )
          : "");
      let existing = yield* getByPath(path);
      if (existing === undefined && workspace !== undefined) {
        const ownership = yield* ownershipLabels(id);
        existing = yield* findByName(
          workspace,
          encodeOwnershipLine(ownership, olds?.name ?? output?.name),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, workspace);
      const named = yield* ownedByAlchemy(id, existing.name);
      const noted = yield* ownedByAlchemy(id, existing.notes);
      return named || noted ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const workspaces = yield* listWorkspacePaths();
        const pages = yield* Effect.forEach(workspaces, listAt, {
          concurrency: 4,
        });
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const workspace = expandWorkspace(news.workspace);
      const ownership = yield* ownershipLabels(id);
      const rawName = yield* toDisplayName(id, news.name, output?.name);
      const displayName = encodeOwnershipLine(ownership, rawName);
      const notes = encodeOwnership(ownership, news.notes);
      const body: tagmanager.Transformation = {
        name: displayName,
        type: news.type,
        notes,
        parameter: news.parameter,
        parentFolderId: news.parentFolderId,
      };

      const path =
        output?.path ??
        (news.transformationId !== undefined
          ? resourcePath(workspace, COLLECTION, news.transformationId)
          : "");

      let current = yield* getByPath(path);
      if (current === undefined) {
        current = yield* findByName(workspace, displayName);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainersWorkspacesTransformations({
            parent: workspace,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByName(workspace, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContainersWorkspacesTransformationNotResolved({
          path: path || `${workspace}/${COLLECTION}`,
        });
      }

      const currentPath = current.path ?? path;
      const changed =
        (current.name ?? "") !== displayName ||
        (current.type ?? "") !== news.type ||
        (current.notes ?? "") !== notes ||
        !sameJson(parametersOf(current.parameter), news.parameter) ||
        !sameText(current.parentFolderId, news.parentFolderId);

      if (changed) {
        current = yield* retryConflict(
          getByPath(currentPath).pipe(
            Effect.flatMap((latest) =>
              tagmanager.updateAccountsContainersWorkspacesTransformations({
                path: currentPath,
                fingerprint: latest?.fingerprint ?? current?.fingerprint,
                body: {
                  ...body,
                  path: currentPath,
                  transformationId:
                    latest?.transformationId ?? current?.transformationId,
                  accountId: latest?.accountId ?? current?.accountId,
                  containerId: latest?.containerId ?? current?.containerId,
                  workspaceId: latest?.workspaceId ?? current?.workspaceId,
                },
              }),
            ),
          ),
        );
      }

      return toAttrs(current, workspace);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* tagmanager
        .deleteAccountsContainersWorkspacesTransformations({
          path: output.path,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
