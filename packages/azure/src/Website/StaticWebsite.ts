import { createHash } from "node:crypto";
import * as cdn from "@distilled.cloud/azure/cdn";
import * as storage from "@distilled.cloud/azure/storage";
import * as blob from "@distilled.cloud/azure/storage-blob";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { initialCwd } from "alchemy/Util/Node";
import { sha256Object } from "alchemy/Util/sha256";
import { cacheControlOf, contentTypeOf } from "alchemy/Website/assets";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { collectAll, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

/** A Front Door endpoint whose cache a deploy purges of changed files. */
export interface StaticWebsitePurgeTarget {
  /** Resource group of the Front Door profile. */
  resourceGroup: string;
  /** Name of the Front Door profile. */
  profile: string;
  /** Name of the endpoint in the profile (`AfdEndpoint.endpointName`). */
  endpoint: string;
}

export interface StaticWebsiteProps {
  /**
   * Resource group of the storage account.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Storage account that hosts the site. Alchemy enables its static
   * website endpoint and owns the contents of its `$web` container.
   * Changing it replaces the resource.
   */
  storageAccount: string;
  /** Directory whose files are published, relative to the working directory. */
  path: string;
  /**
   * Document served for a directory request (`/` and `/docs/`).
   * @default "index.html"
   */
  indexDocument?: string;
  /**
   * Document served, with a `404` status, for a path that matches no file.
   * Set it to the index document for a single-page application; set it to
   * `404.html` for a real not-found page.
   */
  errorDocument404Path?: string;
  /**
   * Front Door endpoint in front of the site. After an upload, Alchemy
   * purges the paths of changed and deleted files from its cache (all of
   * them, `/*`, when more than 100 paths changed).
   */
  purge?: StaticWebsitePurgeTarget;
}

export interface StaticWebsite extends Resource<
  "Azure.Website.StaticWebsite",
  StaticWebsiteProps,
  {
    /** Storage account that hosts the site. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** Static website endpoint, e.g. `https://{account}.z13.web.core.windows.net`. */
    url: string;
    /** Host of {@link url}; use it as a Front Door origin. */
    hostName: string;
    /** Number of published files. */
    fileCount: number;
    /** Hash of the published file set; changes when any file changes. */
    contentHash: string;
    /** Paths the last deploy purged from the Front Door cache (empty when none). */
    purgedPaths: string[];
  },
  never,
  Providers
> {}

/**
 * Publishes a directory to the
 * [static website](https://learn.microsoft.com/azure/storage/blobs/storage-blob-static-website)
 * endpoint of an Azure Storage account.
 *
 * Alchemy enables the endpoint, uploads new and changed files to the `$web`
 * container (with a `Content-Type` and a `Cache-Control` per file: HTML is
 * never cached, other files are immutable), and deletes files that are no
 * longer in the directory. Unchanged files are skipped by MD5. With
 * `purge`, the changed paths are then purged from a Front Door endpoint's
 * cache.
 *
 * Uploads go through the Blob Storage data plane with the deployer's
 * Microsoft Entra token (no account keys, no SAS). The deployer needs
 * **Storage Blob Data Contributor** on the account; the `Azure.Website`
 * composites grant it. A new grant takes a minute or two to apply, and the
 * upload waits for it.
 *
 * Deleting the resource empties `$web` and disables the endpoint; the
 * storage account itself stays.
 *
 * ### Publishing a Directory
 * **Example:** Static files on a storage account
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("Files");
 * const uploader = yield* Azure.Authorization.RoleAssignment("Uploader", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
 *   principalId: deployerObjectId,
 * });
 * const site = yield* Azure.Website.StaticWebsite("Site", {
 *   storageAccount: account.storageAccountName,
 *   path: "dist",
 *   errorDocument404Path: "404.html",
 * });
 * // site.url → "https://{account}.z13.web.core.windows.net"
 * ```
 *
 * ### Purging Front Door
 * **Example:** Purge changed files from a Front Door endpoint
 * ```typescript
 * const site = yield* Azure.Website.StaticWebsite("Site", {
 *   storageAccount: account.storageAccountName,
 *   path: "dist",
 *   purge: {
 *     resourceGroup: profile.resourceGroup,
 *     profile: profile.profileName,
 *     endpoint: endpoint.endpointName,
 *   },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const StaticWebsite = GroupedResource<StaticWebsite>("Azure.Website.StaticWebsite");

export class StaticWebsiteError extends Data.TaggedError("Azure.Website.StaticWebsiteError")<{
  readonly storageAccount: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const WEB_CONTAINER = "$web";

/** Front Door accepts at most 100 content paths per purge. */
const MAX_PURGE_PATHS = 100;

interface LocalFile {
  /** POSIX path relative to the published directory; also the blob name. */
  readonly name: string;
  readonly full: string;
  /** Base64 MD5, the format Blob Storage reports as `Content-MD5`. */
  readonly md5: string;
}

const readLocalFiles = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(initialCwd, dir);
  const names = yield* fs.readDirectory(root, { recursive: true });
  const files = yield* Effect.forEach(
    names,
    (name) =>
      Effect.gen(function* () {
        const full = path.join(root, name);
        const stat = yield* fs.stat(full);
        if (stat.type !== "File") return undefined;
        const bytes = yield* fs.readFile(full);
        const md5 = yield* Effect.sync(() => createHash("md5").update(bytes).digest("base64"));
        return { name: name.split(path.sep).join("/"), full, md5 };
      }),
    { concurrency: 32 },
  );
  return files
    .filter((file): file is LocalFile => file !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
});

const contentHashOf = (files: readonly LocalFile[]) =>
  sha256Object(files.map((file) => [file.name, file.md5])).pipe(
    Effect.map((hash) => hash.slice(0, 16)),
  );

/**
 * A new data-plane role assignment takes a minute or two to apply; Blob
 * Storage answers `AuthorizationPermissionMismatch` until then.
 */
const whileAccessPending = {
  while: (error: { readonly _tag: string }) => error._tag === "SchemaRegistryStorageAccessDenied",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

/** Observe the account; `undefined` once it (or its group) is gone. */
const getAccount = (resourceGroup: string, storageAccount: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      storage.GetStorageAccountProperties({
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
      }),
    );
  });

const endpointOf = (
  account: storage.GetStorageAccountPropertiesResponse,
  storageAccount: string,
  kind: "web" | "blob",
) =>
  (
    account.properties?.primaryEndpoints?.[kind] ??
    `https://${storageAccount}.${kind}.core.windows.net/`
  ).replace(/\/+$/, "");

/** `{blob name → Content-MD5}` of `$web`; empty when it does not exist yet. */
const listWebBlobs = (url: string) =>
  collectAll(blob.ListContainerBlobFlatSegment, { url, containerName: WEB_CONTAINER }).pipe(
    Effect.map(
      (page) =>
        new Map(
          page.value.flatMap((item) =>
            item.Name?.content === undefined
              ? []
              : [[item.Name.content, item.Properties?.Content_MD5] as const],
          ),
        ),
    ),
    Effect.catchTag("ContainerNotFound", () =>
      Effect.succeed(new Map<string, string | undefined>()),
    ),
    Effect.retry(whileAccessPending),
  );

const deleteWebBlob = (url: string, name: string) =>
  blob.DeleteBlob({ url, containerName: WEB_CONTAINER, blob: name }).pipe(
    Effect.catchTag(["BlobNotFound", "ContainerNotFound"], () => Effect.void),
    Effect.retry(whileAccessPending),
  );

/**
 * Paths to purge for changed or deleted files. An index document also
 * purges the directory URLs that serve it (`/docs/` and `/docs`).
 */
const purgePathsOf = (names: readonly string[], indexDocument: string) => {
  const paths = new Set<string>();
  for (const name of names) {
    paths.add(`/${name}`);
    if (name === indexDocument || name.endsWith(`/${indexDocument}`)) {
      const dir = name.slice(0, name.length - indexDocument.length);
      paths.add(`/${dir}`);
      if (dir.length > 0) paths.add(`/${dir.replace(/\/$/, "")}`);
    }
  }
  const sorted = [...paths].sort();
  return sorted.length > MAX_PURGE_PATHS ? ["/*"] : sorted;
};

export const StaticWebsiteProvider = () =>
  Provider.succeed(StaticWebsite, {
    stables: ["storageAccount", "resourceGroup"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (
        olds !== undefined &&
        (olds.storageAccount !== news.storageAccount || olds.resourceGroup !== news.resourceGroup)
      ) {
        return { action: "replace" } as const;
      }
      if (output === undefined) return undefined;
      // The directory path can stay the same while its files change.
      const files = yield* readLocalFiles(news.path).pipe(
        Effect.orElseSucceed(() => [] as LocalFile[]),
      );
      const contentHash = yield* contentHashOf(files);
      if (contentHash !== output.contentHash) {
        return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const account = yield* getAccount(resourceGroup, storageAccount);
      if (account === undefined) return undefined;
      return output;
    }),

    reconcile: Effect.fn(function* ({ news, session }) {
      // Observe.
      const account = yield* getAccount(news.resourceGroup, news.storageAccount);
      if (account === undefined) {
        return yield* new StaticWebsiteError({
          storageAccount: news.storageAccount,
          message: `storage account ${news.storageAccount} does not exist`,
        });
      }
      const url = endpointOf(account, news.storageAccount, "blob");

      // Sync the static website settings against the observed service properties.
      const indexDocument = news.indexDocument ?? "index.html";
      const observed = yield* blob.GetServiceProperties({ url });
      const website = observed.StaticWebsite;
      if (
        website?.Enabled !== true ||
        website.IndexDocument !== indexDocument ||
        website.ErrorDocument404Path !== news.errorDocument404Path
      ) {
        yield* blob.SetServiceProperties({
          url,
          StaticWebsite: {
            Enabled: true,
            IndexDocument: indexDocument,
            ErrorDocument404Path: news.errorDocument404Path,
          },
        });
      }

      // Sync `$web` against the local directory by MD5.
      const files = yield* readLocalFiles(news.path).pipe(
        Effect.mapError(
          (cause) =>
            new StaticWebsiteError({
              storageAccount: news.storageAccount,
              message: `failed to read ${news.path}`,
              cause,
            }),
        ),
      );
      const remote = yield* listWebBlobs(url);
      const changed = files.filter((file) => remote.get(file.name) !== file.md5);
      const wanted = new Set(files.map((file) => file.name));
      const stale = [...remote.keys()].filter((name) => !wanted.has(name));
      if (changed.length > 0) {
        yield* session.note(
          `Uploading ${changed.length} of ${files.length} files to ${news.storageAccount}/$web`,
        );
      }
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.forEach(
        changed,
        (file) =>
          Effect.gen(function* () {
            const body = yield* fs.readFile(file.full);
            yield* blob
              .UploadBlockBlob({
                url,
                containerName: WEB_CONTAINER,
                blob: file.name,
                body,
                xMsBlobContentType: contentTypeOf(file.name),
                xMsBlobCacheControl: cacheControlOf(file.name),
                xMsBlobContentMd5: file.md5,
              })
              .pipe(
                Effect.retry({
                  // Enabling the endpoint creates `$web` asynchronously.
                  while: (error) =>
                    error._tag === "ContainerNotFound" ||
                    error._tag === "SchemaRegistryStorageAccessDenied",
                  schedule: Schedule.spaced("5 seconds"),
                  times: 12,
                }),
              );
          }),
        { concurrency: 16, discard: true },
      );
      yield* Effect.forEach(stale, (name) => deleteWebBlob(url, name), {
        concurrency: 16,
        discard: true,
      });

      // Purge what the edge may still cache: replaced and deleted files.
      const replaced = changed.filter((file) => remote.has(file.name)).map((file) => file.name);
      const purgedPaths =
        news.purge === undefined ? [] : purgePathsOf([...replaced, ...stale], indexDocument);
      if (news.purge !== undefined && purgedPaths.length > 0) {
        const { subscriptionId } = yield* AzureEnvironment.current;
        yield* session.note(`Purging ${purgedPaths.length} paths from ${news.purge.endpoint}`);
        // Purging runs asynchronously on the edge; the request returns at once.
        yield* cdn.PurgeAFDEndpointContent({
          subscriptionId,
          resourceGroupName: news.purge.resourceGroup,
          profileName: news.purge.profile,
          endpointName: news.purge.endpoint,
          contentPaths: purgedPaths,
        });
      }

      const webUrl = endpointOf(account, news.storageAccount, "web");
      const contentHash = yield* contentHashOf(files);
      return {
        storageAccount: news.storageAccount,
        resourceGroup: news.resourceGroup,
        url: webUrl,
        hostName: new URL(webUrl).hostname,
        fileCount: files.length,
        contentHash,
        purgedPaths,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const account = yield* getAccount(output.resourceGroup, output.storageAccount);
      if (account === undefined) return;
      const url = endpointOf(account, output.storageAccount, "blob");
      const remote = yield* listWebBlobs(url);
      yield* Effect.forEach([...remote.keys()], (name) => deleteWebBlob(url, name), {
        concurrency: 16,
        discard: true,
      });
      yield* blob.SetServiceProperties({ url, StaticWebsite: { Enabled: false } });
    }),
  });
