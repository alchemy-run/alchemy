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
  conditionsOf,
  encodeOwnership,
  encodeOwnershipLine,
  expandWorkspace,
  isOwnedEntity,
  lastSegment,
  listWorkspacePaths,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  resourcePath,
  retryConflict,
  sameJson,
  toDisplayName,
  type TagmanagerCondition,
  workspacePathOf,
} from "./internal.ts";

export type ZoneBoundary = {
  /** Conjoined conditions that make up the boundary. */
  condition?: TagmanagerCondition[];
  /** Custom evaluation trigger ids. */
  customEvaluationTriggerId?: string[];
};

export type ZoneTypeRestriction = {
  /** Whether type restrictions are enabled. */
  enable?: boolean;
  /** Whitelisted type public ids. */
  whitelistedTypeId?: string[];
};

export type ZoneChildContainer = {
  /** Child container public id (`GTM-XXXX`). */
  publicId?: string;
  /** Nickname for the child container. */
  nickname?: string;
};

export type ContainersWorkspacesZoneProps = {
  /**
   * Parent workspace path
   * `accounts/{account}/containers/{container}/workspaces/{workspace}`.
   * Immutable — changing it replaces the zone.
   */
  workspace: string;
  /**
   * Server-assigned zone id. Immutable — changing it replaces the zone.
   */
  zoneId?: string;
  /**
   * Display name unique within the workspace. Zones have no labels
   * field, so Alchemy stamps ownership into `name` and `notes`.
   */
  name?: string;
  /**
   * User notes. Alchemy also stamps ownership here so `list` / nuke can
   * find the zone.
   */
  notes?: string;
  /** Zone boundary. */
  boundary?: ZoneBoundary;
  /** Type restrictions. */
  typeRestriction?: ZoneTypeRestriction;
  /** Child containers included in this zone. */
  childContainer?: ZoneChildContainer[];
};

export type ContainersWorkspacesZone = Resource<
  "GCP.Tagmanager.ContainersWorkspacesZone",
  ContainersWorkspacesZoneProps,
  {
    /** GTM API relative path. */
    path: string;
    /** Zone id. */
    zoneId: string;
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
    /** User notes with the Alchemy ownership prefix stripped. */
    notes: string | undefined;
    /** Zone boundary. */
    boundary: ZoneBoundary | undefined;
    /** Type restrictions. */
    typeRestriction: ZoneTypeRestriction | undefined;
    /** Child containers. */
    childContainer: ZoneChildContainer[] | undefined;
    /** Storage fingerprint. */
    fingerprint: string | undefined;
    /** Tag Manager UI URL. */
    tagManagerUrl: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tag Manager zone in a container workspace.
 *
 * Zones have no labels field — Alchemy stamps ownership into `name` and
 * `notes` so `list` / nuke can find them. Parent workspace and id are
 * immutable. Display name, notes, boundary, type restrictions, and
 * child containers update in place.
 *
 * ### Creating a Zone
 * **Example:** Zone wrapping a child container
 * ```typescript
 * const zone = yield* GCP.Tagmanager.ContainersWorkspacesZone("Embed", {
 *   workspace: workspacePath,
 *   childContainer: [
 *     { publicId: child.publicId, nickname: "child" },
 *   ],
 * });
 * ```
 *
 * ### Updating a Zone
 * **Example:** Rename the child nickname
 * ```typescript
 * const zone = yield* GCP.Tagmanager.ContainersWorkspacesZone("Embed", {
 *   workspace: existing.workspace,
 *   zoneId: existing.zoneId,
 *   childContainer: [
 *     { publicId: child.publicId, nickname: "embedded" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const ContainersWorkspacesZone = Resource<ContainersWorkspacesZone>(
  "GCP.Tagmanager.ContainersWorkspacesZone",
);

export class ContainersWorkspacesZoneNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainersWorkspacesZoneNotResolved",
)<{
  path: string;
}> {}

const COLLECTION = "zones";

const boundaryOf = (
  boundary: tagmanager.ZoneBoundary | undefined,
): ZoneBoundary | undefined => {
  if (boundary === undefined) return undefined;
  return {
    condition: conditionsOf(boundary.condition),
    customEvaluationTriggerId: boundary.customEvaluationTriggerId,
  };
};

const typeRestrictionOf = (
  restriction: tagmanager.ZoneTypeRestriction | undefined,
): ZoneTypeRestriction | undefined => {
  if (restriction === undefined) return undefined;
  return {
    enable: restriction.enable,
    whitelistedTypeId: restriction.whitelistedTypeId,
  };
};

const childContainersOf = (
  list: readonly tagmanager.ZoneChildContainer[] | undefined,
): ZoneChildContainer[] | undefined => {
  if (list === undefined) return undefined;
  return list.map((child) => ({
    publicId: child.publicId,
    nickname: child.nickname,
  }));
};

const toAttrs = (zone: tagmanager.Zone, workspaceHint?: string) => {
  const path = zone.path ?? "";
  return {
    path,
    zoneId: zone.zoneId ?? lastSegment(path),
    workspace: path.includes("/zones/")
      ? parentOf(path)
      : (workspaceHint ?? workspacePathOf(path)),
    accountId: zone.accountId,
    containerId: zone.containerId,
    workspaceId: zone.workspaceId,
    name: parseOwnership(zone.name).text,
    notes: parseOwnership(zone.notes).text,
    boundary: boundaryOf(zone.boundary),
    typeRestriction: typeRestrictionOf(zone.typeRestriction),
    childContainer: childContainersOf(zone.childContainer),
    fingerprint: zone.fingerprint,
    tagManagerUrl: zone.tagManagerUrl,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainersWorkspacesZones({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  tagmanager.listAccountsContainersWorkspacesZones.pages({ parent }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.zone ?? [])),
    Stream.filter(isOwnedEntity),
    Stream.map((zone) => toAttrs(zone, parent)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.catchTag("Forbidden", () => Effect.succeed([])),
  );

const findByName = (parent: string, name: string) =>
  tagmanager.listAccountsContainersWorkspacesZones.pages({ parent }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.zone ?? [])),
    Stream.filter((zone) => zone.name === name),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
  );

export const ContainersWorkspacesZoneProvider = () =>
  Provider.succeed(ContainersWorkspacesZone, {
    stables: [
      "path",
      "zoneId",
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
      const previousId = olds?.zoneId ?? output?.zoneId;
      if (
        previousId !== undefined &&
        news.zoneId !== undefined &&
        news.zoneId !== previousId
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
        (olds?.zoneId ?? output?.zoneId) !== undefined
          ? resourcePath(
              workspace,
              COLLECTION,
              olds?.zoneId ?? output?.zoneId ?? "",
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
      const body: tagmanager.Zone = {
        name: displayName,
        notes,
        boundary: news.boundary,
        typeRestriction: news.typeRestriction,
        childContainer: news.childContainer,
      };

      const path =
        output?.path ??
        (news.zoneId !== undefined
          ? resourcePath(workspace, COLLECTION, news.zoneId)
          : "");

      let current = yield* getByPath(path);
      if (current === undefined) {
        current = yield* findByName(workspace, displayName);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainersWorkspacesZones({
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
        return yield* new ContainersWorkspacesZoneNotResolved({
          path: path || `${workspace}/${COLLECTION}`,
        });
      }

      const currentPath = current.path ?? path;
      const changed =
        (current.name ?? "") !== displayName ||
        (current.notes ?? "") !== notes ||
        !sameJson(boundaryOf(current.boundary), news.boundary) ||
        !sameJson(
          typeRestrictionOf(current.typeRestriction),
          news.typeRestriction,
        ) ||
        !sameJson(
          childContainersOf(current.childContainer),
          news.childContainer,
        );

      if (changed) {
        current = yield* retryConflict(
          getByPath(currentPath).pipe(
            Effect.flatMap((latest) =>
              tagmanager.updateAccountsContainersWorkspacesZones({
                path: currentPath,
                fingerprint: latest?.fingerprint ?? current?.fingerprint,
                body: {
                  ...body,
                  path: currentPath,
                  zoneId: latest?.zoneId ?? current?.zoneId,
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
        .deleteAccountsContainersWorkspacesZones({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
