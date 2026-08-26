import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  containerPath,
  encodeOwnership,
  expandAccount,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  listAccountPaths,
  listContainersAt,
  ownedByAlchemy,
  parseOwnership,
  parsePath,
  retryConflict,
  sameStringList,
  sameText,
  TagmanagerNotResolved,
  toDisplayName,
} from "./internal.ts";

export type ContainerUsageContext =
  | "usageContextUnspecified"
  | "web"
  | "android"
  | "ios"
  | "androidSdk5"
  | "iosSdk5"
  | "amp"
  | "server";

export type ContainerProps = {
  /**
   * GTM account path (`accounts/{account}`) or account id. Immutable —
   * changing it replaces the container.
   */
  account: string;
  /**
   * GTM container id. Server-assigned when omitted. Immutable — changing
   * it replaces the container.
   */
  containerId?: string;
  /**
   * Container display name. Unique within the account. Generated when
   * omitted.
   */
  name?: string;
  /**
   * Container notes. GTM containers have no labels field, so Alchemy
   * stamps ownership into this field and strips it from attributes.
   */
  notes?: string;
  /**
   * Usage contexts (`web`, `server`, `android`, `ios`, `amp`, …).
   * Immutable — changing them replaces the container.
   * @default ["web"]
   */
  usageContext?: ContainerUsageContext[];
  /**
   * Domain names associated with the container.
   */
  domainName?: string[];
  /**
   * Server-side container URLs. All URL paths must match when more than
   * one is set.
   */
  taggingServerUrls?: string[];
};

export type Container = Resource<
  "GCP.Tagmanager.Container",
  ContainerProps,
  {
    /** GTM API path `accounts/{account}/containers/{container}`. */
    path: string;
    /** Parent account path `accounts/{account}`. */
    account: string;
    /** GTM account id. */
    accountId: string;
    /** GTM container id. */
    containerId: string;
    /** Public container id (`GTM-XXXX`). */
    publicId: string | undefined;
    /** User display name. */
    name: string | undefined;
    /** User notes with the Alchemy ownership prefix stripped. */
    notes: string | undefined;
    /** Usage contexts. */
    usageContext: ContainerUsageContext[] | undefined;
    /** Associated domain names. */
    domainName: string[] | undefined;
    /** Server-side tagging URLs. */
    taggingServerUrls: string[] | undefined;
    /** Tag ids that refer to this container. */
    tagIds: string[] | undefined;
    /** Tag Manager UI URL. */
    tagManagerUrl: string | undefined;
    /** Storage fingerprint used for optimistic updates. */
    fingerprint: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tag Manager container.
 *
 * GTM containers have no labels field — Alchemy stamps ownership into
 * `notes` so `list` / nuke can find them. Account, container id, and
 * usage context are immutable. Display name, notes, domain names, and
 * tagging-server URLs update in place.
 *
 * ### Creating a Container
 * **Example:** Web container
 * ```typescript
 * const container = yield* GCP.Tagmanager.Container("Web", {
 *   account: "accounts/123456",
 *   name: "web",
 *   usageContext: ["web"],
 *   notes: "marketing site",
 * });
 * ```
 *
 * **Example:** Server container
 * ```typescript
 * const container = yield* GCP.Tagmanager.Container("Server", {
 *   account: "accounts/123456",
 *   name: "server",
 *   usageContext: ["server"],
 * });
 * ```
 *
 * ### Updating a Container
 * **Example:** Change notes and domains
 * ```typescript
 * const container = yield* GCP.Tagmanager.Container("Web", {
 *   account: existing.account,
 *   containerId: existing.containerId,
 *   name: "web",
 *   notes: "marketing site v2",
 *   domainName: ["example.com"],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const Container = Resource<Container>("GCP.Tagmanager.Container");

export class ContainerNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainerNotResolved",
)<{
  path: string;
}> {}

const DEFAULT_USAGE: ContainerUsageContext[] = ["web"];

const usageOf = (
  usage: readonly string[] | undefined,
): ContainerUsageContext[] | undefined =>
  usage === undefined
    ? undefined
    : usage.map((item) => item as ContainerUsageContext);

const toAttrs = (container: tagmanager.Container, accountHint?: string) => {
  const path =
    container.path ??
    (container.accountId && container.containerId
      ? containerPath(container.accountId, container.containerId)
      : "");
  const parsed = parsePath(path);
  return {
    path,
    account:
      parsed.account ||
      accountHint ||
      (container.accountId ? expandAccount(container.accountId) : ""),
    accountId: container.accountId ?? parsed.accountId ?? "",
    containerId:
      container.containerId ?? parsed.containerId ?? lastSegment(path),
    publicId: container.publicId,
    name: container.name,
    notes: parseOwnership(container.notes).text,
    usageContext: usageOf(container.usageContext),
    domainName: container.domainName,
    taggingServerUrls: container.taggingServerUrls,
    tagIds: container.tagIds,
    tagManagerUrl: container.tagManagerUrl,
    fingerprint: container.fingerprint,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainers({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  account: string,
  id: string,
  name: string | undefined,
  notes: string | undefined,
) =>
  listContainersAt(account).pipe(
    Effect.flatMap((containers) =>
      Effect.gen(function* () {
        for (const container of containers) {
          if (notes !== undefined && container.notes === notes) {
            return container;
          }
          if (
            name !== undefined &&
            container.name === name &&
            (yield* ownedByAlchemy(id, container.notes))
          ) {
            return container;
          }
          if (yield* ownedByAlchemy(id, container.notes)) {
            return container;
          }
        }
        return undefined;
      }),
    ),
  );

export const ContainerProvider = () =>
  Provider.succeed(Container, {
    stables: ["path", "account", "accountId", "containerId", "publicId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAccount = olds?.account ?? output?.account;
      if (
        previousAccount !== undefined &&
        expandAccount(news.account) !== expandAccount(previousAccount)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.containerId ?? output?.containerId;
      if (
        previousId !== undefined &&
        news.containerId !== undefined &&
        news.containerId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousUsage = olds?.usageContext ?? output?.usageContext;
      const nextUsage = news.usageContext ?? DEFAULT_USAGE;
      if (
        previousUsage !== undefined &&
        !sameStringList(previousUsage, nextUsage)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const account = expandAccount(olds?.account ?? output?.account ?? "");
      const path =
        output?.path ??
        (olds?.containerId && account
          ? containerPath(account, olds.containerId)
          : "");
      let existing = yield* getByPath(path);
      if (existing === undefined && account.length > 0) {
        existing = yield* findOwned(account, id, olds?.name, undefined);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, account);
      return (yield* ownedByAlchemy(id, existing.notes))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const accounts = yield* listAccountPaths();
        const groups = yield* Effect.forEach(
          accounts,
          (account) =>
            listContainersAt(account).pipe(
              Effect.map((containers) =>
                containers
                  .filter((container) => hasOwnershipMarker(container.notes))
                  .map((container) => toAttrs(container, account)),
              ),
            ),
          { concurrency: 4 },
        );
        return groups.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const account = expandAccount(news.account);
      const path =
        output?.path ??
        (news.containerId ? containerPath(account, news.containerId) : "");
      const ownership = yield* internalLabels(id);
      const name = yield* toDisplayName(id, news.name, output?.name);
      const notes = encodeOwnership(ownership, news.notes);
      const usageContext = news.usageContext ?? DEFAULT_USAGE;

      let current = yield* getByPath(output?.path ?? path);
      if (current === undefined) {
        current = yield* findOwned(account, id, name, notes);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainers({
            parent: account,
            body: {
              name,
              notes,
              usageContext,
              domainName: news.domainName,
              taggingServerUrls: news.taggingServerUrls,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(account, id, name, notes),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContainerNotResolved({
          path: path || `${account}/containers/-`,
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
      const domainChanged = !sameStringList(
        current.domainName,
        news.domainName,
      );
      const urlsChanged = !sameStringList(
        current.taggingServerUrls,
        news.taggingServerUrls,
      );

      if (nameChanged || notesChanged || domainChanged || urlsChanged) {
        const updated = yield* retryConflict(
          Effect.gen(function* () {
            const fresh = yield* getByPath(currentPath);
            if (fresh === undefined) return undefined;
            return yield* tagmanager.updateAccountsContainers({
              path: currentPath,
              fingerprint: fresh.fingerprint,
              body: {
                path: currentPath,
                accountId: fresh.accountId,
                containerId: fresh.containerId,
                name,
                notes,
                usageContext: fresh.usageContext,
                domainName: news.domainName,
                taggingServerUrls: news.taggingServerUrls,
              },
            });
          }),
        );
        current = updated ?? current;
      }

      return toAttrs(current, account);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* tagmanager
        .deleteAccountsContainers({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
