import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  expandContainer,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  listEnvironmentsAt,
  eachContainer,
  ownedByAlchemy,
  parseOwnership,
  parsePath,
  retryConflict,
  sameBool,
  sameText,
  TagmanagerNotResolved,
  toDisplayName,
} from "./internal.ts";

export type EnvironmentType = "user" | "live" | "latest" | "workspace";

export type ContainersEnvironmentProps = {
  /**
   * Parent container path
   * (`accounts/{account}/containers/{container}`) or container id when
   * `account` is also set. Immutable — changing it replaces the
   * environment.
   */
  container: string;
  /**
   * Account path or id used when `container` is an id. Immutable —
   * changing it replaces the environment.
   */
  account?: string;
  /**
   * GTM environment id. Server-assigned when omitted. Immutable —
   * changing it replaces the environment.
   */
  environmentId?: string;
  /**
   * Environment display name. Only user environments accept a name.
   * Generated when omitted.
   */
  name?: string;
  /**
   * Environment description. GTM environments have no labels field, so
   * Alchemy stamps ownership here and strips it from attributes.
   */
  description?: string;
  /**
   * Default preview page URL.
   */
  url?: string;
  /**
   * Enable debug by default.
   * @default false
   */
  enableDebug?: boolean;
  /**
   * Workspace id to preview. User environments only.
   */
  workspaceId?: string;
  /**
   * Container version id to pin. User environments only.
   */
  containerVersionId?: string;
};

export type ContainersEnvironment = Resource<
  "GCP.Tagmanager.ContainersEnvironment",
  ContainersEnvironmentProps,
  {
    /** GTM API path `.../containers/{container}/environments/{environment}`. */
    path: string;
    /** Parent container path. */
    container: string;
    /** Parent account path. */
    account: string;
    /** GTM account id. */
    accountId: string;
    /** GTM container id. */
    containerId: string;
    /** GTM environment id. */
    environmentId: string;
    /** User display name. */
    name: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Environment type (`user`, `live`, `latest`, `workspace`). */
    type: EnvironmentType | undefined;
    /** Preview URL. */
    url: string | undefined;
    /** Whether debug is enabled by default. */
    enableDebug: boolean;
    /** Linked workspace id. */
    workspaceId: string | undefined;
    /** Pinned container version id. */
    containerVersionId: string | undefined;
    /** Authorization code. */
    authorizationCode: string | undefined;
    /** Authorization timestamp. */
    authorizationTimestamp: string | undefined;
    /** Tag Manager UI URL. */
    tagManagerUrl: string | undefined;
    /** Storage fingerprint used for optimistic updates. */
    fingerprint: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tag Manager user environment.
 *
 * Only `user` environments can be created. Live, latest, and workspace
 * environments are system-managed. Alchemy stamps ownership into
 * `description` so `list` / nuke can find the environment. Parent
 * container and id are immutable. Name, description, URL, debug flag,
 * workspace, and version pin update in place.
 *
 * ### Creating an Environment
 * **Example:** Preview environment
 * ```typescript
 * const environment = yield* GCP.Tagmanager.ContainersEnvironment("Preview", {
 *   container: container.path,
 *   name: "preview",
 *   description: "QA preview",
 *   enableDebug: true,
 * });
 * ```
 *
 * ### Updating an Environment
 * **Example:** Change the preview URL
 * ```typescript
 * const environment = yield* GCP.Tagmanager.ContainersEnvironment("Preview", {
 *   container: existing.container,
 *   environmentId: existing.environmentId,
 *   name: "preview",
 *   url: "https://example.com/preview",
 *   enableDebug: false,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const ContainersEnvironment = Resource<ContainersEnvironment>(
  "GCP.Tagmanager.ContainersEnvironment",
);

export class ContainersEnvironmentNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainersEnvironmentNotResolved",
)<{
  path: string;
}> {}

const toAttrs = (
  environment: tagmanager.Environment,
  containerHint?: string,
) => {
  const path = environment.path ?? "";
  const parsed = parsePath(path);
  return {
    path,
    container: parsed.container || containerHint || "",
    account: parsed.account,
    accountId: environment.accountId ?? parsed.accountId ?? "",
    containerId: environment.containerId ?? parsed.containerId ?? "",
    environmentId:
      environment.environmentId ?? parsed.environmentId ?? lastSegment(path),
    name: environment.name,
    description: parseOwnership(environment.description).text,
    type: environment.type as EnvironmentType | undefined,
    url: environment.url,
    enableDebug: environment.enableDebug === true,
    workspaceId: environment.workspaceId,
    containerVersionId: environment.containerVersionId,
    authorizationCode: environment.authorizationCode,
    authorizationTimestamp: environment.authorizationTimestamp,
    tagManagerUrl: environment.tagManagerUrl,
    fingerprint: environment.fingerprint,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainersEnvironments({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  container: string,
  id: string,
  name: string | undefined,
  description: string | undefined,
) =>
  listEnvironmentsAt(container).pipe(
    Effect.flatMap((environments) =>
      Effect.gen(function* () {
        for (const environment of environments) {
          if (
            description !== undefined &&
            environment.description === description
          ) {
            return environment;
          }
          if (
            name !== undefined &&
            environment.name === name &&
            (yield* ownedByAlchemy(id, environment.description))
          ) {
            return environment;
          }
          if (yield* ownedByAlchemy(id, environment.description)) {
            return environment;
          }
        }
        return undefined;
      }),
    ),
  );

export const ContainersEnvironmentProvider = () =>
  Provider.succeed(ContainersEnvironment, {
    stables: [
      "path",
      "container",
      "account",
      "accountId",
      "containerId",
      "environmentId",
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
      const previousId = olds?.environmentId ?? output?.environmentId;
      if (
        previousId !== undefined &&
        news.environmentId !== undefined &&
        news.environmentId !== previousId
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
        (olds?.environmentId && container
          ? `${container}/environments/${olds.environmentId}`
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
        listEnvironmentsAt(container).pipe(
          Effect.map((environments) =>
            environments
              .filter((environment) =>
                hasOwnershipMarker(environment.description),
              )
              .map((environment) => toAttrs(environment, container)),
          ),
        ),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const container = expandContainer(news.container, news.account);
      const path =
        output?.path ??
        (news.environmentId
          ? `${container}/environments/${news.environmentId}`
          : "");
      const ownership = yield* internalLabels(id);
      const name = yield* toDisplayName(id, news.name, output?.name);
      const description = encodeOwnership(ownership, news.description);
      const enableDebug = news.enableDebug === true;

      let current = yield* getByPath(output?.path ?? path);
      if (current === undefined) {
        current = yield* findOwned(container, id, name, description);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainersEnvironments({
            parent: container,
            body: {
              name,
              description,
              url: news.url,
              enableDebug,
              workspaceId: news.workspaceId,
              containerVersionId: news.containerVersionId,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(container, id, name, description),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContainersEnvironmentNotResolved({
          path: path || `${container}/environments/-`,
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
      const urlChanged = !sameText(current.url, news.url);
      const debugChanged = !sameBool(current.enableDebug, enableDebug);
      const workspaceChanged = !sameText(current.workspaceId, news.workspaceId);
      const versionChanged = !sameText(
        current.containerVersionId,
        news.containerVersionId,
      );

      if (
        nameChanged ||
        descriptionChanged ||
        urlChanged ||
        debugChanged ||
        workspaceChanged ||
        versionChanged
      ) {
        const updated = yield* retryConflict(
          Effect.gen(function* () {
            const fresh = yield* getByPath(currentPath);
            if (fresh === undefined) return undefined;
            return yield* tagmanager.updateAccountsContainersEnvironments({
              path: currentPath,
              fingerprint: fresh.fingerprint,
              body: {
                path: currentPath,
                accountId: fresh.accountId,
                containerId: fresh.containerId,
                environmentId: fresh.environmentId,
                type: fresh.type,
                name,
                description,
                url: news.url,
                enableDebug,
                workspaceId: news.workspaceId,
                containerVersionId: news.containerVersionId,
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
        .deleteAccountsContainersEnvironments({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
