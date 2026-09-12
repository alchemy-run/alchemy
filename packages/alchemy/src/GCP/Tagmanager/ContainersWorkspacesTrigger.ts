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
  fingerprint,
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
  type TagmanagerCondition,
  type TagmanagerParameter,
  workspacePathOf,
} from "./internal.ts";

export type ContainersWorkspacesTriggerProps = {
  /**
   * Parent workspace path
   * `accounts/{account}/containers/{container}/workspaces/{workspace}`.
   * Immutable — changing it replaces the trigger.
   */
  workspace: string;
  /**
   * Server-assigned trigger id. Immutable — changing it replaces the
   * trigger.
   */
  triggerId?: string;
  /**
   * Display name unique within the workspace. Triggers have no labels
   * field, so Alchemy stamps ownership into `name` and `notes`.
   */
  name?: string;
  /**
   * Trigger type (`pageview`, `customEvent`, `click`, `always`, …).
   * @default "pageview"
   */
  type?: string;
  /**
   * User notes. Alchemy also stamps ownership here so `list` / nuke can
   * find the trigger.
   */
  notes?: string;
  /** Conditions that must all be true for the trigger to fire. */
  filter?: TagmanagerCondition[];
  /** Auto-event tracking conditions. */
  autoEventFilter?: TagmanagerCondition[];
  /** Custom-event conditions. */
  customEventFilter?: TagmanagerCondition[];
  /** Additional parameters. */
  parameter?: TagmanagerParameter[];
  /** Click CSS selector (AMP click triggers). */
  selector?: TagmanagerParameter;
  /** Timer event name. */
  eventName?: TagmanagerParameter;
  /** Form/link validation check. */
  checkValidation?: TagmanagerParameter;
  /** Timer interval in milliseconds. */
  interval?: TagmanagerParameter;
  /** Timer event limit. */
  limit?: TagmanagerParameter;
  /** Parent folder id. */
  parentFolderId?: string;
};

export type ContainersWorkspacesTrigger = Resource<
  "GCP.Tagmanager.ContainersWorkspacesTrigger",
  ContainersWorkspacesTriggerProps,
  {
    /** GTM API relative path. */
    path: string;
    /** Trigger id. */
    triggerId: string;
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
    /** Trigger type. */
    type: string | undefined;
    /** User notes with the Alchemy ownership prefix stripped. */
    notes: string | undefined;
    /** Fire conditions. */
    filter: TagmanagerCondition[] | undefined;
    /** Auto-event conditions. */
    autoEventFilter: TagmanagerCondition[] | undefined;
    /** Custom-event conditions. */
    customEventFilter: TagmanagerCondition[] | undefined;
    /** Additional parameters. */
    parameter: TagmanagerParameter[] | undefined;
    /** Click CSS selector. */
    selector: TagmanagerParameter | undefined;
    /** Timer event name. */
    eventName: TagmanagerParameter | undefined;
    /** Form/link validation check. */
    checkValidation: TagmanagerParameter | undefined;
    /** Timer interval. */
    interval: TagmanagerParameter | undefined;
    /** Timer event limit. */
    limit: TagmanagerParameter | undefined;
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
 * A Google Tag Manager trigger in a container workspace.
 *
 * Triggers have no labels field — Alchemy stamps ownership into `name`
 * and `notes` so `list` / nuke can find them. Parent workspace and id
 * are immutable. Display name, type, notes, filters, and parameters
 * update in place.
 *
 * ### Creating a Trigger
 * **Example:** Pageview trigger
 * ```typescript
 * const trigger = yield* GCP.Tagmanager.ContainersWorkspacesTrigger(
 *   "Pageview",
 *   {
 *     workspace: workspacePath,
 *     type: "pageview",
 *   },
 * );
 * ```
 *
 * ### Updating a Trigger
 * **Example:** Rename and add notes
 * ```typescript
 * const trigger = yield* GCP.Tagmanager.ContainersWorkspacesTrigger(
 *   "Pageview",
 *   {
 *     workspace: existing.workspace,
 *     triggerId: existing.triggerId,
 *     type: "pageview",
 *     name: "all pages",
 *     notes: "fires on every page",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const ContainersWorkspacesTrigger =
  Resource<ContainersWorkspacesTrigger>(
    "GCP.Tagmanager.ContainersWorkspacesTrigger",
  );

export class ContainersWorkspacesTriggerNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainersWorkspacesTriggerNotResolved",
)<{
  path: string;
}> {}

const DEFAULT_TYPE = "pageview";
const COLLECTION = "triggers";

const parameterOf = (
  parameter: tagmanager.Parameter | undefined,
): TagmanagerParameter | undefined => {
  if (parameter === undefined) return undefined;
  return {
    type: parameter.type,
    key: parameter.key,
    value: parameter.value,
    map: parametersOf(parameter.map),
    list: parametersOf(parameter.list),
    isWeakReference: parameter.isWeakReference,
  };
};

const toAttrs = (trigger: tagmanager.Trigger, workspaceHint?: string) => {
  const path = trigger.path ?? "";
  return {
    path,
    triggerId: trigger.triggerId ?? lastSegment(path),
    workspace: path.includes("/triggers/")
      ? parentOf(path)
      : (workspaceHint ?? workspacePathOf(path)),
    accountId: trigger.accountId,
    containerId: trigger.containerId,
    workspaceId: trigger.workspaceId,
    name: parseOwnership(trigger.name).text,
    type: trigger.type,
    notes: parseOwnership(trigger.notes).text,
    filter: conditionsOf(trigger.filter),
    autoEventFilter: conditionsOf(trigger.autoEventFilter),
    customEventFilter: conditionsOf(trigger.customEventFilter),
    parameter: parametersOf(trigger.parameter),
    selector: parameterOf(trigger.selector),
    eventName: parameterOf(trigger.eventName),
    checkValidation: parameterOf(trigger.checkValidation),
    interval: parameterOf(trigger.interval),
    limit: parameterOf(trigger.limit),
    parentFolderId: trigger.parentFolderId,
    fingerprint: trigger.fingerprint,
    tagManagerUrl: trigger.tagManagerUrl,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainersWorkspacesTriggers({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  tagmanager.listAccountsContainersWorkspacesTriggers.pages({ parent }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.trigger ?? [])),
    Stream.filter(isOwnedEntity),
    Stream.map((trigger) => toAttrs(trigger, parent)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.catchTag("Forbidden", () => Effect.succeed([])),
  );

const findByName = (parent: string, name: string) =>
  tagmanager.listAccountsContainersWorkspacesTriggers.pages({ parent }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.trigger ?? [])),
    Stream.filter((trigger) => trigger.name === name),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
  );

export const ContainersWorkspacesTriggerProvider = () =>
  Provider.succeed(ContainersWorkspacesTrigger, {
    stables: [
      "path",
      "triggerId",
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
      const previousId = olds?.triggerId ?? output?.triggerId;
      if (
        previousId !== undefined &&
        news.triggerId !== undefined &&
        news.triggerId !== previousId
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
        (olds?.triggerId ?? output?.triggerId) !== undefined
          ? resourcePath(
              workspace,
              COLLECTION,
              olds?.triggerId ?? output?.triggerId ?? "",
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
      const type = news.type ?? DEFAULT_TYPE;
      const body: tagmanager.Trigger = {
        name: displayName,
        type,
        notes,
        filter: news.filter,
        autoEventFilter: news.autoEventFilter,
        customEventFilter: news.customEventFilter,
        parameter: news.parameter,
        selector: news.selector,
        eventName: news.eventName,
        checkValidation: news.checkValidation,
        interval: news.interval,
        limit: news.limit,
        parentFolderId: news.parentFolderId,
      };

      const path =
        output?.path ??
        (news.triggerId !== undefined
          ? resourcePath(workspace, COLLECTION, news.triggerId)
          : "");

      let current = yield* getByPath(path);
      if (current === undefined) {
        current = yield* findByName(workspace, displayName);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainersWorkspacesTriggers({
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
        return yield* new ContainersWorkspacesTriggerNotResolved({
          path: path || `${workspace}/${COLLECTION}`,
        });
      }

      const currentPath = current.path ?? path;
      const changed =
        (current.name ?? "") !== displayName ||
        (current.type ?? "") !== type ||
        (current.notes ?? "") !== notes ||
        !sameJson(conditionsOf(current.filter), news.filter) ||
        !sameJson(
          conditionsOf(current.autoEventFilter),
          news.autoEventFilter,
        ) ||
        !sameJson(
          conditionsOf(current.customEventFilter),
          news.customEventFilter,
        ) ||
        !sameJson(parametersOf(current.parameter), news.parameter) ||
        fingerprint(parameterOf(current.selector)) !==
          fingerprint(news.selector) ||
        fingerprint(parameterOf(current.eventName)) !==
          fingerprint(news.eventName) ||
        fingerprint(parameterOf(current.checkValidation)) !==
          fingerprint(news.checkValidation) ||
        fingerprint(parameterOf(current.interval)) !==
          fingerprint(news.interval) ||
        fingerprint(parameterOf(current.limit)) !== fingerprint(news.limit) ||
        !sameText(current.parentFolderId, news.parentFolderId);

      if (changed) {
        current = yield* retryConflict(
          getByPath(currentPath).pipe(
            Effect.flatMap((latest) =>
              tagmanager.updateAccountsContainersWorkspacesTriggers({
                path: currentPath,
                fingerprint: latest?.fingerprint ?? current?.fingerprint,
                body: {
                  ...body,
                  path: currentPath,
                  triggerId: latest?.triggerId ?? current?.triggerId,
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
        .deleteAccountsContainersWorkspacesTriggers({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
