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
  resolveWorkspace,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  listGtagConfigsAt,
  ownedByAlchemy,
  ownershipFromParameters,
  parsePath,
  retryConflict,
  sameJson,
  sameText,
  stripOwnershipParameter,
  TagmanagerNotResolved,
  withOwnershipParameter,
  type Parameter,
} from "./internal.ts";

export type GtagParameter = Parameter;

export type ContainersWorkspacesGtagProps = {
  /**
   * Parent workspace path
   * (`accounts/{account}/containers/{container}/workspaces/{workspace}`)
   * or workspace id when `container` is also set. Immutable — changing
   * it replaces the Google tag config.
   */
  workspace: string;
  /**
   * Parent container path used when `workspace` is an id. Immutable —
   * changing it replaces the Google tag config.
   */
  container?: string;
  /**
   * Google tag config id. Server-assigned when omitted. Immutable —
   * changing it replaces the config.
   */
  gtagConfigId?: string;
  /**
   * Google tag config type (`googtag`, `gaawe`, …). Required.
   */
  type: string;
  /**
   * Config parameters. Alchemy stamps an `_alchemy` ownership parameter
   * and strips it from attributes — Google tag configs have no notes
   * field.
   */
  parameter?: GtagParameter[];
};

export type ContainersWorkspacesGtag = Resource<
  "GCP.Tagmanager.ContainersWorkspacesGtag",
  ContainersWorkspacesGtagProps,
  {
    /** GTM API path `.../workspaces/{workspace}/gtag_config/{gtagConfig}`. */
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
    /** Google tag config id. */
    gtagConfigId: string;
    /** Config type. */
    type: string | undefined;
    /** User parameters with the Alchemy ownership parameter stripped. */
    parameter: GtagParameter[] | undefined;
    /** Tag Manager UI URL. */
    tagManagerUrl: string | undefined;
    /** Storage fingerprint used for optimistic updates. */
    fingerprint: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google tag configuration in a GTM workspace.
 *
 * Google tag configs have no notes or display-name field — Alchemy
 * stamps ownership into an `_alchemy` parameter so `list` / nuke can
 * find them. Parent workspace and id are immutable. Type and parameters
 * update in place.
 *
 * ### Creating a Google tag config
 * **Example:** Google tag
 * ```typescript
 * const gtag = yield* GCP.Tagmanager.ContainersWorkspacesGtag("Ga", {
 *   workspace: workspace.path,
 *   type: "googtag",
 *   parameter: [
 *     { type: "template", key: "tagId", value: "G-TEST000000" },
 *   ],
 * });
 * ```
 *
 * ### Updating a Google tag config
 * **Example:** Change the tag id
 * ```typescript
 * const gtag = yield* GCP.Tagmanager.ContainersWorkspacesGtag("Ga", {
 *   workspace: existing.workspace,
 *   gtagConfigId: existing.gtagConfigId,
 *   type: "googtag",
 *   parameter: [
 *     { type: "template", key: "tagId", value: "G-TEST000001" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const ContainersWorkspacesGtag = Resource<ContainersWorkspacesGtag>(
  "GCP.Tagmanager.ContainersWorkspacesGtag",
);

export class ContainersWorkspacesGtagNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainersWorkspacesGtagNotResolved",
)<{
  path: string;
}> {}

const toAttrs = (config: tagmanager.GtagConfig, workspaceHint?: string) => {
  const path = config.path ?? "";
  const parsed = parsePath(path);
  const stripped = stripOwnershipParameter(config.parameter);
  return {
    path,
    workspace: parsed.workspace || workspaceHint || "",
    container: parsed.container,
    account: parsed.account,
    accountId: config.accountId ?? parsed.accountId ?? "",
    containerId: config.containerId ?? parsed.containerId ?? "",
    workspaceId: config.workspaceId ?? parsed.workspaceId ?? "",
    gtagConfigId:
      config.gtagConfigId ?? parsed.gtagConfigId ?? lastSegment(path),
    type: config.type,
    parameter: stripped.parameter,
    tagManagerUrl: config.tagManagerUrl,
    fingerprint: config.fingerprint,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainersWorkspacesGtag_config({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (workspace: string, id: string, parameter: Parameter[]) =>
  listGtagConfigsAt(workspace).pipe(
    Effect.flatMap((configs) =>
      Effect.gen(function* () {
        for (const config of configs) {
          const marker = ownershipFromParameters(config.parameter);
          if (yield* ownedByAlchemy(id, marker)) return config;
          if (sameJson(config.parameter, parameter)) return config;
        }
        return undefined;
      }),
    ),
  );

export const ContainersWorkspacesGtagProvider = () =>
  Provider.succeed(ContainersWorkspacesGtag, {
    stables: [
      "path",
      "workspace",
      "container",
      "account",
      "accountId",
      "containerId",
      "workspaceId",
      "gtagConfigId",
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
      const previousId = olds?.gtagConfigId ?? output?.gtagConfigId;
      if (
        previousId !== undefined &&
        news.gtagConfigId !== undefined &&
        news.gtagConfigId !== previousId
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
        (olds?.gtagConfigId && workspace
          ? `${workspace}/gtag_config/${olds.gtagConfigId}`
          : "");
      let existing = yield* getByPath(path);
      if (existing === undefined && workspace.length > 0) {
        existing = yield* findOwned(workspace, id, []);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, workspace);
      return (yield* ownedByAlchemy(
        id,
        ownershipFromParameters(existing.parameter),
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      eachWorkspace((workspace) =>
        listGtagConfigsAt(workspace).pipe(
          Effect.map((configs) =>
            configs
              .filter((config) =>
                hasOwnershipMarker(ownershipFromParameters(config.parameter)),
              )
              .map((config) => toAttrs(config, workspace)),
          ),
        ),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const workspace = resolveWorkspace(news.workspace, news.container);
      const path =
        output?.path ??
        (news.gtagConfigId
          ? `${workspace}/gtag_config/${news.gtagConfigId}`
          : "");
      const ownership = yield* internalLabels(id);
      const parameter = withOwnershipParameter(ownership, news.parameter);
      const body: tagmanager.GtagConfig = {
        type: news.type,
        parameter,
      };

      let current = yield* getByPath(output?.path ?? path);
      if (current === undefined) {
        current = yield* findOwned(workspace, id, parameter);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainersWorkspacesGtag_config({
            parent: workspace,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(workspace, id, parameter),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContainersWorkspacesGtagNotResolved({
          path: path || `${workspace}/gtag_config/-`,
        });
      }

      if (
        !(yield* ownedByAlchemy(id, ownershipFromParameters(current.parameter)))
      ) {
        return yield* new TagmanagerNotResolved({
          path: current.path ?? path,
        });
      }

      const currentPath = current.path ?? path;
      const changed =
        !sameText(current.type, news.type) ||
        !sameJson(current.parameter, parameter);

      if (changed) {
        const updated = yield* retryConflict(
          Effect.gen(function* () {
            const fresh = yield* getByPath(currentPath);
            if (fresh === undefined) return undefined;
            return yield* tagmanager.updateAccountsContainersWorkspacesGtag_config(
              {
                path: currentPath,
                fingerprint: fresh.fingerprint,
                body: {
                  ...body,
                  path: currentPath,
                  accountId: fresh.accountId,
                  containerId: fresh.containerId,
                  workspaceId: fresh.workspaceId,
                  gtagConfigId: fresh.gtagConfigId,
                },
              },
            );
          }),
        );
        current = updated ?? current;
      }

      return toAttrs(current, workspace);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* tagmanager
        .deleteAccountsContainersWorkspacesGtag_config({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
