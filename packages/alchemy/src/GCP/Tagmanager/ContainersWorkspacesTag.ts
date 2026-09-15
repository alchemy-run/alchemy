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
  listTagsAt,
  ownedByAlchemy,
  parametersOf,
  parseOwnership,
  parsePath,
  retryConflict,
  sameBool,
  sameJson,
  sameStringList,
  sameText,
  TagmanagerNotResolved,
  toDisplayName,
  type Parameter,
} from "./internal.ts";

export type TagParameter = Parameter;

export type TagFiringOption =
  | "tagFiringOptionUnspecified"
  | "unlimited"
  | "oncePerEvent"
  | "oncePerLoad";

export type TagConsentStatus = "notSet" | "notNeeded" | "needed";

export type TagSetupTag = {
  /** Name of the setup tag. */
  tagName?: string;
  /** Fire the main tag only when setup succeeds. */
  stopOnSetupFailure?: boolean;
};

export type TagTeardownTag = {
  /** Name of the teardown tag. */
  tagName?: string;
  /** Fire teardown only when the main tag succeeds. */
  stopTeardownOnFailure?: boolean;
};

export type TagConsentSetting = {
  /** Consent status (`notSet`, `notNeeded`, `needed`). */
  consentStatus?: TagConsentStatus;
  /** Consent types to check when status is `needed`. */
  consentType?: TagParameter;
};

export type ContainersWorkspacesTagProps = {
  /**
   * Parent workspace path
   * (`accounts/{account}/containers/{container}/workspaces/{workspace}`)
   * or workspace id when `container` is also set. Immutable — changing
   * it replaces the tag.
   */
  workspace: string;
  /**
   * Parent container path used when `workspace` is an id. Immutable —
   * changing it replaces the tag.
   */
  container?: string;
  /**
   * GTM tag id. Server-assigned when omitted. Immutable — changing it
   * replaces the tag.
   */
  tagId?: string;
  /**
   * GTM tag type (`html`, `img`, `gaawe`, …). Required.
   */
  type: string;
  /**
   * Tag display name. Generated when omitted.
   */
  name?: string;
  /**
   * Tag notes. Alchemy stamps ownership here and strips it from
   * attributes.
   */
  notes?: string;
  /**
   * Tag parameters.
   */
  parameter?: TagParameter[];
  /**
   * Firing trigger ids.
   */
  firingTriggerId?: string[];
  /**
   * Blocking trigger ids.
   */
  blockingTriggerId?: string[];
  /**
   * Pause the tag so it does not fire.
   * @default false
   */
  paused?: boolean;
  /**
   * Fire only in the live environment.
   * @default false
   */
  liveOnly?: boolean;
  /**
   * Tag firing option (`unlimited`, `oncePerEvent`, `oncePerLoad`).
   */
  tagFiringOption?: TagFiringOption;
  /**
   * Parent folder id.
   */
  parentFolderId?: string;
  /**
   * Numeric priority as a GTM parameter.
   */
  priority?: TagParameter;
  /**
   * Setup tags that fire before this tag.
   */
  setupTag?: TagSetupTag[];
  /**
   * Teardown tags that fire after this tag.
   */
  teardownTag?: TagTeardownTag[];
  /**
   * Schedule start timestamp in milliseconds.
   */
  scheduleStartMs?: string;
  /**
   * Schedule end timestamp in milliseconds.
   */
  scheduleEndMs?: string;
  /**
   * Consent settings.
   */
  consentSettings?: TagConsentSetting;
  /**
   * Monitoring metadata map.
   */
  monitoringMetadata?: TagParameter;
  /**
   * Key used to inject the tag display name into monitoring metadata.
   */
  monitoringMetadataTagNameKey?: string;
};

export type ContainersWorkspacesTag = Resource<
  "GCP.Tagmanager.ContainersWorkspacesTag",
  ContainersWorkspacesTagProps,
  {
    /** GTM API path `.../workspaces/{workspace}/tags/{tag}`. */
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
    /** GTM tag id. */
    tagId: string;
    /** Tag type. */
    type: string | undefined;
    /** User display name. */
    name: string | undefined;
    /** User notes with the Alchemy ownership prefix stripped. */
    notes: string | undefined;
    /** Tag parameters. */
    parameter: TagParameter[] | undefined;
    /** Firing trigger ids. */
    firingTriggerId: string[] | undefined;
    /** Blocking trigger ids. */
    blockingTriggerId: string[] | undefined;
    /** Whether the tag is paused. */
    paused: boolean;
    /** Whether the tag fires only in live. */
    liveOnly: boolean;
    /** Tag firing option. */
    tagFiringOption: TagFiringOption | undefined;
    /** Parent folder id. */
    parentFolderId: string | undefined;
    /** Priority parameter. */
    priority: TagParameter | undefined;
    /** Setup tags. */
    setupTag: TagSetupTag[] | undefined;
    /** Teardown tags. */
    teardownTag: TagTeardownTag[] | undefined;
    /** Schedule start (ms). */
    scheduleStartMs: string | undefined;
    /** Schedule end (ms). */
    scheduleEndMs: string | undefined;
    /** Consent settings. */
    consentSettings: TagConsentSetting | undefined;
    /** Monitoring metadata. */
    monitoringMetadata: TagParameter | undefined;
    /** Monitoring metadata tag-name key. */
    monitoringMetadataTagNameKey: string | undefined;
    /** Tag Manager UI URL. */
    tagManagerUrl: string | undefined;
    /** Storage fingerprint used for optimistic updates. */
    fingerprint: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tag Manager tag in a workspace.
 *
 * Alchemy stamps ownership into `notes` so `list` / nuke can find the
 * tag. Parent workspace and id are immutable. Type, name, notes,
 * parameters, triggers, pause flag, and the rest of the tag config
 * update in place.
 *
 * ### Creating a Tag
 * **Example:** HTML tag
 * ```typescript
 * const tag = yield* GCP.Tagmanager.ContainersWorkspacesTag("Pixel", {
 *   workspace: workspace.path,
 *   type: "html",
 *   name: "pixel",
 *   parameter: [
 *     { type: "template", key: "html", value: "<script></script>" },
 *     { type: "boolean", key: "supportDocumentWrite", value: "false" },
 *   ],
 * });
 * ```
 *
 * ### Updating a Tag
 * **Example:** Pause the tag
 * ```typescript
 * const tag = yield* GCP.Tagmanager.ContainersWorkspacesTag("Pixel", {
 *   workspace: existing.workspace,
 *   tagId: existing.tagId,
 *   type: "html",
 *   name: "pixel",
 *   paused: true,
 *   parameter: existing.parameter,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const ContainersWorkspacesTag = Resource<ContainersWorkspacesTag>(
  "GCP.Tagmanager.ContainersWorkspacesTag",
);

export class ContainersWorkspacesTagNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainersWorkspacesTagNotResolved",
)<{
  path: string;
}> {}

const setupOf = (
  list: readonly tagmanager.SetupTag[] | readonly TagSetupTag[] | undefined,
): TagSetupTag[] | undefined => {
  if (list === undefined) return undefined;
  return list.map((tag) => ({
    tagName: tag.tagName,
    stopOnSetupFailure: tag.stopOnSetupFailure,
  }));
};

const teardownOf = (
  list:
    | readonly tagmanager.TeardownTag[]
    | readonly TagTeardownTag[]
    | undefined,
): TagTeardownTag[] | undefined => {
  if (list === undefined) return undefined;
  return list.map((tag) => ({
    tagName: tag.tagName,
    stopTeardownOnFailure: tag.stopTeardownOnFailure,
  }));
};

const consentOf = (
  settings: tagmanager.TagConsentSetting | TagConsentSetting | undefined,
): TagConsentSetting | undefined => {
  if (settings === undefined) return undefined;
  return {
    consentStatus: settings.consentStatus as TagConsentStatus | undefined,
    consentType: settings.consentType
      ? parametersOf([settings.consentType])?.[0]
      : undefined,
  };
};

const toAttrs = (tag: tagmanager.Tag, workspaceHint?: string) => {
  const path = tag.path ?? "";
  const parsed = parsePath(path);
  return {
    path,
    workspace: parsed.workspace || workspaceHint || "",
    container: parsed.container,
    account: parsed.account,
    accountId: tag.accountId ?? parsed.accountId ?? "",
    containerId: tag.containerId ?? parsed.containerId ?? "",
    workspaceId: tag.workspaceId ?? parsed.workspaceId ?? "",
    tagId: tag.tagId ?? parsed.tagId ?? lastSegment(path),
    type: tag.type,
    name: tag.name,
    notes: parseOwnership(tag.notes).text,
    parameter: parametersOf(tag.parameter),
    firingTriggerId: tag.firingTriggerId,
    blockingTriggerId: tag.blockingTriggerId,
    paused: tag.paused === true,
    liveOnly: tag.liveOnly === true,
    tagFiringOption: tag.tagFiringOption as TagFiringOption | undefined,
    parentFolderId: tag.parentFolderId,
    priority: tag.priority ? parametersOf([tag.priority])?.[0] : undefined,
    setupTag: setupOf(tag.setupTag),
    teardownTag: teardownOf(tag.teardownTag),
    scheduleStartMs: tag.scheduleStartMs,
    scheduleEndMs: tag.scheduleEndMs,
    consentSettings: consentOf(tag.consentSettings),
    monitoringMetadata: tag.monitoringMetadata
      ? parametersOf([tag.monitoringMetadata])?.[0]
      : undefined,
    monitoringMetadataTagNameKey: tag.monitoringMetadataTagNameKey,
    tagManagerUrl: tag.tagManagerUrl,
    fingerprint: tag.fingerprint,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainersWorkspacesTags({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  workspace: string,
  id: string,
  name: string | undefined,
  notes: string | undefined,
) =>
  listTagsAt(workspace).pipe(
    Effect.flatMap((tags) =>
      Effect.gen(function* () {
        for (const tag of tags) {
          if (notes !== undefined && tag.notes === notes) return tag;
          if (
            name !== undefined &&
            tag.name === name &&
            (yield* ownedByAlchemy(id, tag.notes))
          ) {
            return tag;
          }
          if (yield* ownedByAlchemy(id, tag.notes)) return tag;
        }
        return undefined;
      }),
    ),
  );

export const ContainersWorkspacesTagProvider = () =>
  Provider.succeed(ContainersWorkspacesTag, {
    stables: [
      "path",
      "workspace",
      "container",
      "account",
      "accountId",
      "containerId",
      "workspaceId",
      "tagId",
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
      const previousId = olds?.tagId ?? output?.tagId;
      if (
        previousId !== undefined &&
        news.tagId !== undefined &&
        news.tagId !== previousId
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
        (olds?.tagId && workspace ? `${workspace}/tags/${olds.tagId}` : "");
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
        listTagsAt(workspace).pipe(
          Effect.map((tags) =>
            tags
              .filter((tag) => hasOwnershipMarker(tag.notes))
              .map((tag) => toAttrs(tag, workspace)),
          ),
        ),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const workspace = resolveWorkspace(news.workspace, news.container);
      const path =
        output?.path ?? (news.tagId ? `${workspace}/tags/${news.tagId}` : "");
      const ownership = yield* internalLabels(id);
      const name = yield* toDisplayName(id, news.name, output?.name);
      const notes = encodeOwnership(ownership, news.notes);
      const paused = news.paused === true;
      const liveOnly = news.liveOnly === true;
      const body: tagmanager.Tag = {
        type: news.type,
        name,
        notes,
        parameter: news.parameter,
        firingTriggerId: news.firingTriggerId,
        blockingTriggerId: news.blockingTriggerId,
        paused,
        liveOnly,
        tagFiringOption: news.tagFiringOption,
        parentFolderId: news.parentFolderId,
        priority: news.priority,
        setupTag: news.setupTag,
        teardownTag: news.teardownTag,
        scheduleStartMs: news.scheduleStartMs,
        scheduleEndMs: news.scheduleEndMs,
        consentSettings: news.consentSettings,
        monitoringMetadata: news.monitoringMetadata,
        monitoringMetadataTagNameKey: news.monitoringMetadataTagNameKey,
      };

      let current = yield* getByPath(output?.path ?? path);
      if (current === undefined) {
        current = yield* findOwned(workspace, id, name, notes);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainersWorkspacesTags({
            parent: workspace,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(workspace, id, name, notes),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContainersWorkspacesTagNotResolved({
          path: path || `${workspace}/tags/-`,
        });
      }

      if (!(yield* ownedByAlchemy(id, current.notes))) {
        return yield* new TagmanagerNotResolved({
          path: current.path ?? path,
        });
      }

      const currentPath = current.path ?? path;
      const observed = toAttrs(current, workspace);
      const changed =
        !sameText(current.type, news.type) ||
        !sameText(current.name, name) ||
        !sameText(current.notes, notes) ||
        !sameJson(observed.parameter, news.parameter) ||
        !sameStringList(current.firingTriggerId, news.firingTriggerId) ||
        !sameStringList(current.blockingTriggerId, news.blockingTriggerId) ||
        !sameBool(current.paused, paused) ||
        !sameBool(current.liveOnly, liveOnly) ||
        !sameText(current.tagFiringOption, news.tagFiringOption) ||
        !sameText(current.parentFolderId, news.parentFolderId) ||
        !sameJson(observed.priority, news.priority) ||
        !sameJson(observed.setupTag, news.setupTag) ||
        !sameJson(observed.teardownTag, news.teardownTag) ||
        !sameText(current.scheduleStartMs, news.scheduleStartMs) ||
        !sameText(current.scheduleEndMs, news.scheduleEndMs) ||
        !sameJson(observed.consentSettings, news.consentSettings) ||
        !sameJson(observed.monitoringMetadata, news.monitoringMetadata) ||
        !sameText(
          current.monitoringMetadataTagNameKey,
          news.monitoringMetadataTagNameKey,
        );

      if (changed) {
        const updated = yield* retryConflict(
          Effect.gen(function* () {
            const fresh = yield* getByPath(currentPath);
            if (fresh === undefined) return undefined;
            return yield* tagmanager.updateAccountsContainersWorkspacesTags({
              path: currentPath,
              fingerprint: fresh.fingerprint,
              body: {
                ...body,
                path: currentPath,
                accountId: fresh.accountId,
                containerId: fresh.containerId,
                workspaceId: fresh.workspaceId,
                tagId: fresh.tagId,
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
        .deleteAccountsContainersWorkspacesTags({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
