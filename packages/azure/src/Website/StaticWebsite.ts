import { createHash } from "node:crypto";
import * as storage from "@distilled.cloud/azure/storage";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { initialCwd } from "alchemy/Util/Node";
import { sha256Object } from "alchemy/Util/sha256";
import { cacheControlOf, contentTypeOf } from "alchemy/Website/assets";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { orUndefinedIfNotFound } from "../Arm.ts";
import { xmlElements, xmlField } from "../Binding.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface StaticWebsiteProps {
  /** Resource group of the storage account. */
  resourceGroup: string;
  /**
   * Storage account that hosts the site. Alchemy enables its static
   * website endpoint and owns the contents of its `$web` container. The
   * account must allow shared-key access (the default): uploads use an
   * account SAS minted through Azure Resource Manager.
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
 * longer in the directory. Unchanged files are skipped by MD5. No Docker
 * and no build service are involved: the upload goes straight to Blob
 * Storage.
 *
 * Deleting the resource empties `$web` and disables the endpoint; the
 * storage account itself stays.
 *
 * ### Publishing a Directory
 * **Example:** Static files on a storage account
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("site");
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const site = yield* Azure.Website.StaticWebsite("Site", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   path: "dist",
 *   errorDocument404Path: "404.html",
 * });
 * // site.url → "https://{account}.z13.web.core.windows.net"
 * ```
 *
 * @resource
 * @product Website
 */
export const StaticWebsite = Resource<StaticWebsite>("Azure.Website.StaticWebsite");

export class StaticWebsiteError extends Data.TaggedError("Azure.Website.StaticWebsiteError")<{
  readonly storageAccount: string;
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

const STORAGE_VERSION = "2023-11-03";
const WEB_CONTAINER = "$web";

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
        if ((yield* fs.stat(full)).type !== "File") return undefined;
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

const encodeBlobName = (name: string) => name.split("/").map(encodeURIComponent).join("/");

const xmlEscape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Blob data-plane access to one account through an ARM-minted account SAS. */
const blobClient = Effect.fn(function* (resourceGroup: string, storageAccount: string) {
  const { subscriptionId } = yield* AzureEnvironment.current;
  const http = yield* HttpClient.HttpClient;
  const expiry = new Date((yield* Effect.sync(() => Date.now())) + 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const { accountSasToken } = yield* storage.ListStorageAccountAccountSAS({
    subscriptionId,
    resourceGroupName: resourceGroup,
    accountName: storageAccount,
    signedServices: "b",
    signedResourceTypes: "sco",
    signedPermission: "rwdlc",
    signedProtocol: "https",
    signedExpiry: expiry,
  });
  if (accountSasToken === undefined) {
    return yield* new StaticWebsiteError({
      storageAccount,
      message: "Azure returned no account SAS token",
    });
  }
  const base = `https://${storageAccount}.blob.core.windows.net`;

  const send = (request: HttpClientRequest.HttpClientRequest, allow: readonly number[] = []) =>
    http.execute(request.pipe(HttpClientRequest.setHeader("x-ms-version", STORAGE_VERSION))).pipe(
      Effect.mapError(
        (cause) =>
          new StaticWebsiteError({
            storageAccount,
            message: `${request.method} ${request.url.split("?")[0]} failed`,
            cause,
          }),
      ),
      Effect.flatMap((response) =>
        response.status < 300 || allow.includes(response.status)
          ? Effect.succeed(response)
          : response.text.pipe(
              Effect.orElseSucceed(() => ""),
              Effect.flatMap((body) =>
                Effect.fail(
                  new StaticWebsiteError({
                    storageAccount,
                    status: response.status,
                    message: `${request.method} ${request.url.split("?")[0]} returned ${response.status}: ${body.slice(0, 300)}`,
                  }),
                ),
              ),
            ),
      ),
      // Throttling and transient server errors.
      Effect.retry({
        while: (error) => error.status === undefined || error.status === 429 || error.status >= 500,
        schedule: Schedule.exponential("500 millis"),
        times: 5,
      }),
    );

  const url = (resource: string, query: string) =>
    `${base}${resource}?${query}${query ? "&" : ""}${accountSasToken}`;

  const getStaticWebsite = send(
    HttpClientRequest.get(url("/", "restype=service&comp=properties")),
  ).pipe(
    Effect.flatMap((response) => response.text),
    Effect.mapError(
      (cause) =>
        new StaticWebsiteError({
          storageAccount,
          message: "failed to read blob service properties",
          cause,
        }),
    ),
    Effect.map((xml) => {
      const section = xmlField(xml, "StaticWebsite") ?? "";
      return {
        enabled: xmlField(section, "Enabled") === "true",
        indexDocument: xmlField(section, "IndexDocument"),
        errorDocument404Path: xmlField(section, "ErrorDocument404Path"),
      };
    }),
  );

  const setStaticWebsite = (website: {
    enabled: boolean;
    indexDocument?: string;
    errorDocument404Path?: string;
  }) =>
    send(
      HttpClientRequest.put(url("/", "restype=service&comp=properties")).pipe(
        HttpClientRequest.bodyText(
          [
            `<?xml version="1.0" encoding="utf-8"?>`,
            `<StorageServiceProperties><StaticWebsite>`,
            `<Enabled>${website.enabled}</Enabled>`,
            website.indexDocument !== undefined
              ? `<IndexDocument>${xmlEscape(website.indexDocument)}</IndexDocument>`
              : "",
            website.errorDocument404Path !== undefined
              ? `<ErrorDocument404Path>${xmlEscape(website.errorDocument404Path)}</ErrorDocument404Path>`
              : "",
            `</StaticWebsite></StorageServiceProperties>`,
          ].join(""),
          "application/xml",
        ),
      ),
    ).pipe(Effect.asVoid);

  /** `{blob name → Content-MD5}` of `$web`; empty when it does not exist yet. */
  const listBlobs = Effect.gen(function* () {
    const blobs = new Map<string, string | undefined>();
    let marker: string | undefined;
    // 5000 blobs per page; 200 pages bounds the walk at one million blobs.
    for (let page = 0; page < 200; page++) {
      const response = yield* send(
        HttpClientRequest.get(
          url(
            `/${WEB_CONTAINER}`,
            `restype=container&comp=list${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`,
          ),
        ),
        [404],
      );
      if (response.status === 404) return blobs;
      const xml = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new StaticWebsiteError({
              storageAccount,
              message: "failed to read the blob listing",
              cause,
            }),
        ),
      );
      for (const blob of xmlElements(xml, "Blob")) {
        const name = xmlField(blob, "Name");
        if (name !== undefined) blobs.set(name, xmlField(blob, "Content-MD5"));
      }
      marker = xmlField(xml, "NextMarker");
      if (!marker) return blobs;
    }
    return blobs;
  });

  const putBlob = (file: LocalFile) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bytes = yield* fs.readFile(file.full).pipe(
        Effect.mapError(
          (cause) =>
            new StaticWebsiteError({
              storageAccount,
              message: `failed to read ${file.full}`,
              cause,
            }),
        ),
      );
      const contentType = contentTypeOf(file.name);
      yield* send(
        HttpClientRequest.put(url(`/${WEB_CONTAINER}/${encodeBlobName(file.name)}`, "")).pipe(
          HttpClientRequest.setHeaders({
            "x-ms-blob-type": "BlockBlob",
            "x-ms-blob-content-type": contentType,
            "x-ms-blob-cache-control": cacheControlOf(file.name),
            "x-ms-blob-content-md5": file.md5,
          }),
          HttpClientRequest.bodyUint8Array(bytes, contentType),
        ),
      );
    });

  const deleteBlob = (name: string) =>
    send(
      HttpClientRequest.delete(url(`/${WEB_CONTAINER}/${encodeBlobName(name)}`, "")),
      [404],
    ).pipe(Effect.asVoid);

  return {
    getStaticWebsite,
    setStaticWebsite,
    listBlobs,
    putBlob,
    deleteBlob,
  };
});

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

const webEndpointOf = (
  account: storage.GetStorageAccountPropertiesResponse,
  storageAccount: string,
) =>
  (
    account.properties?.primaryEndpoints?.web ?? `https://${storageAccount}.web.core.windows.net/`
  ).replace(/\/+$/, "");

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
      if ((yield* contentHashOf(files)) !== output.contentHash) {
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
      const account = yield* getAccount(news.resourceGroup, news.storageAccount);
      if (account === undefined) {
        return yield* new StaticWebsiteError({
          storageAccount: news.storageAccount,
          message: `storage account ${news.storageAccount} does not exist`,
        });
      }
      const client = yield* blobClient(news.resourceGroup, news.storageAccount);

      // Sync the static website settings against the observed service properties.
      const desired = {
        enabled: true,
        indexDocument: news.indexDocument ?? "index.html",
        errorDocument404Path: news.errorDocument404Path,
      };
      const observed = yield* client.getStaticWebsite;
      if (
        !observed.enabled ||
        observed.indexDocument !== desired.indexDocument ||
        observed.errorDocument404Path !== desired.errorDocument404Path
      ) {
        yield* client.setStaticWebsite(desired);
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
      // Enabling the endpoint creates `$web` asynchronously.
      const remote = yield* client.listBlobs;
      const changed = files.filter((file) => remote.get(file.name) !== file.md5);
      const wanted = new Set(files.map((file) => file.name));
      const stale = [...remote.keys()].filter((name) => !wanted.has(name));
      if (changed.length > 0) {
        yield* session.note(
          `Uploading ${changed.length} of ${files.length} files to ${news.storageAccount}/$web`,
        );
      }
      yield* Effect.forEach(
        changed,
        (file) =>
          client.putBlob(file).pipe(
            Effect.retry({
              // `$web` not created yet right after enabling the endpoint.
              while: (error) => error.status === 404,
              schedule: Schedule.spaced("2 seconds"),
              times: 10,
            }),
          ),
        { concurrency: 16, discard: true },
      );
      yield* Effect.forEach(stale, client.deleteBlob, {
        concurrency: 16,
        discard: true,
      });

      const url = webEndpointOf(account, news.storageAccount);
      return {
        storageAccount: news.storageAccount,
        resourceGroup: news.resourceGroup,
        url,
        hostName: new URL(url).hostname,
        fileCount: files.length,
        contentHash: yield* contentHashOf(files),
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const account = yield* getAccount(output.resourceGroup, output.storageAccount);
      if (account === undefined) return;
      const client = yield* blobClient(output.resourceGroup, output.storageAccount);
      const remote = yield* client.listBlobs;
      yield* Effect.forEach([...remote.keys()], client.deleteBlob, {
        concurrency: 16,
        discard: true,
      });
      yield* client.setStaticWebsite({ enabled: false });
    }),
  });
