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
  sameStringList,
  sameText,
  toDisplayName,
  type TagmanagerParameter,
  workspacePathOf,
} from "./internal.ts";

export type VariableFormatValue = {
  /** Convert the value to a boolean. */
  convertToBoolean?: boolean;
  /** Convert a string to `lowercase` or `uppercase`. */
  caseConversionType?: string;
  /** Replacement when the value is null. */
  convertNullToValue?: TagmanagerParameter;
  /** Replacement when the value is undefined. */
  convertUndefinedToValue?: TagmanagerParameter;
  /** Replacement when the value is false. */
  convertFalseToValue?: TagmanagerParameter;
  /** Convert the value to a number (`period` or `comma` decimal). */
  convertToNumber?: string;
  /** Replacement when the value is true. */
  convertTrueToValue?: TagmanagerParameter;
};

export type ContainersWorkspacesVariableProps = {
  /**
   * Parent workspace path
   * `accounts/{account}/containers/{container}/workspaces/{workspace}`.
   * Immutable — changing it replaces the variable.
   */
  workspace: string;
  /**
   * Server-assigned variable id. Immutable — changing it replaces the
   * variable.
   */
  variableId?: string;
  /**
   * Display name unique within the workspace. Variables have no labels
   * field, so Alchemy stamps ownership into `name` and `notes`.
   */
  name?: string;
  /**
   * Variable type (`c` constant, `v` data layer, `jsm` custom JS, …).
   * @default "c"
   */
  type?: string;
  /**
   * User notes. Alchemy also stamps ownership here so `list` / nuke can
   * find the variable.
   */
  notes?: string;
  /** Variable parameters. */
  parameter?: TagmanagerParameter[];
  /** Value conversion options. */
  formatValue?: VariableFormatValue;
  /** Enabling trigger ids (mobile containers). */
  enablingTriggerId?: string[];
  /** Disabling trigger ids (mobile containers). */
  disablingTriggerId?: string[];
  /** Schedule start timestamp in milliseconds. */
  scheduleStartMs?: string;
  /** Schedule end timestamp in milliseconds. */
  scheduleEndMs?: string;
  /** Parent folder id. */
  parentFolderId?: string;
};

export type ContainersWorkspacesVariable = Resource<
  "GCP.Tagmanager.ContainersWorkspacesVariable",
  ContainersWorkspacesVariableProps,
  {
    /** GTM API relative path. */
    path: string;
    /** Variable id. */
    variableId: string;
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
    /** Variable type. */
    type: string | undefined;
    /** User notes with the Alchemy ownership prefix stripped. */
    notes: string | undefined;
    /** Variable parameters. */
    parameter: TagmanagerParameter[] | undefined;
    /** Value conversion options. */
    formatValue: VariableFormatValue | undefined;
    /** Enabling trigger ids. */
    enablingTriggerId: string[] | undefined;
    /** Disabling trigger ids. */
    disablingTriggerId: string[] | undefined;
    /** Schedule start timestamp. */
    scheduleStartMs: string | undefined;
    /** Schedule end timestamp. */
    scheduleEndMs: string | undefined;
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
 * A Google Tag Manager variable in a container workspace.
 *
 * Variables have no labels field — Alchemy stamps ownership into `name`
 * and `notes` so `list` / nuke can find them. Parent workspace and id
 * are immutable. Display name, type, notes, parameters, and format
 * options update in place.
 *
 * ### Creating a Variable
 * **Example:** Constant variable
 * ```typescript
 * const variable = yield* GCP.Tagmanager.ContainersWorkspacesVariable(
 *   "Env",
 *   {
 *     workspace: workspacePath,
 *     type: "c",
 *     parameter: [
 *       { type: "template", key: "value", value: "prod" },
 *     ],
 *   },
 * );
 * ```
 *
 * ### Updating a Variable
 * **Example:** Change the constant value
 * ```typescript
 * const variable = yield* GCP.Tagmanager.ContainersWorkspacesVariable(
 *   "Env",
 *   {
 *     workspace: existing.workspace,
 *     variableId: existing.variableId,
 *     type: "c",
 *     parameter: [
 *       { type: "template", key: "value", value: "staging" },
 *     ],
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const ContainersWorkspacesVariable =
  Resource<ContainersWorkspacesVariable>(
    "GCP.Tagmanager.ContainersWorkspacesVariable",
  );

export class ContainersWorkspacesVariableNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainersWorkspacesVariableNotResolved",
)<{
  path: string;
}> {}

const DEFAULT_TYPE = "c";
const COLLECTION = "variables";

const formatValueOf = (
  format: tagmanager.VariableFormatValue | undefined,
): VariableFormatValue | undefined => {
  if (format === undefined) return undefined;
  return {
    convertToBoolean: format.convertToBoolean,
    caseConversionType: format.caseConversionType,
    convertNullToValue: format.convertNullToValue,
    convertUndefinedToValue: format.convertUndefinedToValue,
    convertFalseToValue: format.convertFalseToValue,
    convertToNumber: format.convertToNumber,
    convertTrueToValue: format.convertTrueToValue,
  };
};

const toAttrs = (variable: tagmanager.Variable, workspaceHint?: string) => {
  const path = variable.path ?? "";
  return {
    path,
    variableId: variable.variableId ?? lastSegment(path),
    workspace: path.includes("/variables/")
      ? parentOf(path)
      : (workspaceHint ?? workspacePathOf(path)),
    accountId: variable.accountId,
    containerId: variable.containerId,
    workspaceId: variable.workspaceId,
    name: parseOwnership(variable.name).text,
    type: variable.type,
    notes: parseOwnership(variable.notes).text,
    parameter: parametersOf(variable.parameter),
    formatValue: formatValueOf(variable.formatValue),
    enablingTriggerId: variable.enablingTriggerId,
    disablingTriggerId: variable.disablingTriggerId,
    scheduleStartMs: variable.scheduleStartMs,
    scheduleEndMs: variable.scheduleEndMs,
    parentFolderId: variable.parentFolderId,
    fingerprint: variable.fingerprint,
    tagManagerUrl: variable.tagManagerUrl,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainersWorkspacesVariables({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  tagmanager.listAccountsContainersWorkspacesVariables.pages({ parent }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.variable ?? [])),
    Stream.filter(isOwnedEntity),
    Stream.map((variable) => toAttrs(variable, parent)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.catchTag("Forbidden", () => Effect.succeed([])),
  );

const findByName = (parent: string, name: string) =>
  tagmanager.listAccountsContainersWorkspacesVariables.pages({ parent }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.variable ?? [])),
    Stream.filter((variable) => variable.name === name),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
  );

export const ContainersWorkspacesVariableProvider = () =>
  Provider.succeed(ContainersWorkspacesVariable, {
    stables: [
      "path",
      "variableId",
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
      const previousId = olds?.variableId ?? output?.variableId;
      if (
        previousId !== undefined &&
        news.variableId !== undefined &&
        news.variableId !== previousId
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
        (olds?.variableId ?? output?.variableId) !== undefined
          ? resourcePath(
              workspace,
              COLLECTION,
              olds?.variableId ?? output?.variableId ?? "",
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
      const body: tagmanager.Variable = {
        name: displayName,
        type,
        notes,
        parameter: news.parameter,
        formatValue: news.formatValue,
        enablingTriggerId: news.enablingTriggerId,
        disablingTriggerId: news.disablingTriggerId,
        scheduleStartMs: news.scheduleStartMs,
        scheduleEndMs: news.scheduleEndMs,
        parentFolderId: news.parentFolderId,
      };

      const path =
        output?.path ??
        (news.variableId !== undefined
          ? resourcePath(workspace, COLLECTION, news.variableId)
          : "");

      let current = yield* getByPath(path);
      if (current === undefined) {
        current = yield* findByName(workspace, displayName);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainersWorkspacesVariables({
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
        return yield* new ContainersWorkspacesVariableNotResolved({
          path: path || `${workspace}/${COLLECTION}`,
        });
      }

      const currentPath = current.path ?? path;
      const changed =
        (current.name ?? "") !== displayName ||
        (current.type ?? "") !== type ||
        (current.notes ?? "") !== notes ||
        !sameJson(parametersOf(current.parameter), news.parameter) ||
        !sameJson(formatValueOf(current.formatValue), news.formatValue) ||
        !sameStringList(current.enablingTriggerId, news.enablingTriggerId) ||
        !sameStringList(current.disablingTriggerId, news.disablingTriggerId) ||
        !sameText(current.scheduleStartMs, news.scheduleStartMs) ||
        !sameText(current.scheduleEndMs, news.scheduleEndMs) ||
        !sameText(current.parentFolderId, news.parentFolderId);

      if (changed) {
        current = yield* retryConflict(
          getByPath(currentPath).pipe(
            Effect.flatMap((latest) =>
              tagmanager.updateAccountsContainersWorkspacesVariables({
                path: currentPath,
                fingerprint: latest?.fingerprint ?? current?.fingerprint,
                body: {
                  ...body,
                  path: currentPath,
                  variableId: latest?.variableId ?? current?.variableId,
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
        .deleteAccountsContainersWorkspacesVariables({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
