import * as batch from "@distilled.cloud/azure/batch";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface ApplicationPackageProps {
  /** Resource group of the Batch account. Changing it replaces the package. */
  resourceGroup: string;
  /** Name of the Batch account. Changing it replaces the package. */
  account: string;
  /** Name of the application. Changing it replaces the package. */
  application: string;
  /**
   * Package version, e.g. `1.0.0`: letters, digits, hyphens, underscores,
   * and periods. Changing it replaces the package.
   */
  version: string;
  /**
   * Base64-encoded zip file with the package contents. When set, Alchemy
   * uploads it to the package's storage blob and activates the package;
   * when omitted, the package stays `Pending` until you upload and activate
   * it yourself. Changing it replaces the package.
   */
  content?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ApplicationPackage extends Resource<
  "Azure.Batch.ApplicationPackage",
  ApplicationPackageProps,
  {
    /** ARM resource ID of the package. */
    packageId: string;
    /** Package version. */
    version: string;
    /** Name of the application. */
    application: string;
    /** Name of the Batch account. */
    account: string;
    /** Resource group of the Batch account. */
    resourceGroup: string;
    /** `Pending` until activated, then `Active`. */
    state: string | undefined;
    /** Package format once active (`zip`). */
    format: string | undefined;
    /** Time the package was last activated. */
    lastActivationTime: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A version of a Batch application — a zip file Batch extracts onto
 * compute nodes that reference the application.
 *
 * The Batch account needs `autoStorage`: packages are stored as blobs in
 * the auto-storage account. With `content`, the zip is uploaded and the
 * package activated during deploy.
 *
 * @see https://learn.microsoft.com/azure/batch/batch-application-packages
 *
 * ### Creating a Package
 * **Example:** Upload and activate a zip
 * ```typescript
 * const zip = yield* fs.readFile("dist/renderer.zip");
 * const pkg = yield* Azure.Batch.ApplicationPackage("renderer-1", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   application: app.applicationName,
 *   version: "1.0.0",
 *   content: Buffer.from(zip).toString("base64"),
 * });
 * ```
 *
 * **Example:** Pending package uploaded out of band
 * ```typescript
 * const pkg = yield* Azure.Batch.ApplicationPackage("renderer-2", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   application: app.applicationName,
 *   version: "2.0.0",
 * });
 * ```
 *
 * @resource
 */
export const ApplicationPackage = Resource<ApplicationPackage>(
  "Azure.Batch.ApplicationPackage",
);

export class ApplicationPackageUploadFailed extends Data.TaggedError(
  "Azure.Batch.ApplicationPackageUploadFailed",
)<{
  readonly version: string;
  readonly status: number;
  readonly message: string;
}> {}

type ObservedPackage = batch.GetApplicationPackageResponse;

const getPackage = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  applicationName: string,
  versionName: string,
) =>
  orUndefinedIfNotFound(
    batch.GetApplicationPackage({
      subscriptionId,
      resourceGroupName,
      accountName,
      applicationName,
      versionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  application: string,
  version: string,
  pkg: ObservedPackage,
): ApplicationPackage["Attributes"] => ({
  packageId: pkg.id ?? "",
  version,
  application,
  account,
  resourceGroup,
  state: pkg.properties?.state,
  format: pkg.properties?.format,
  lastActivationTime: pkg.properties?.lastActivationTime,
  tags: userTags(pkg.tags),
});

/** Upload the zip to the package's SAS blob URL. */
const uploadBlob = (storageUrl: string, version: string, content: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const bytes = yield* Effect.sync(() =>
      Uint8Array.from(Buffer.from(content, "base64")),
    );
    const response = yield* http.execute(
      HttpClientRequest.put(storageUrl).pipe(
        HttpClientRequest.setHeader("x-ms-blob-type", "BlockBlob"),
        HttpClientRequest.bodyUint8Array(bytes, "application/zip"),
      ),
    );
    if (response.status >= 300) {
      const text = yield* response.text;
      return yield* new ApplicationPackageUploadFailed({
        version,
        status: response.status,
        message: text.slice(0, 500),
      });
    }
  });

export const ApplicationPackageProvider = () =>
  Provider.succeed(ApplicationPackage, {
    stables: [
      "packageId",
      "version",
      "application",
      "account",
      "resourceGroup",
    ],

    // Packages are deleted with their application and Batch account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        news.application.toLowerCase() !== output.application.toLowerCase() ||
        news.version !== output.version ||
        (olds !== undefined && news.content !== olds.content)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      const application = output?.application ?? olds?.application;
      const version = output?.version ?? olds?.version;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        application === undefined ||
        version === undefined
      ) {
        return undefined;
      }
      const observed = yield* getPackage(
        subscriptionId,
        resourceGroup,
        account,
        application,
        version,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        account,
        application,
        version,
        observed,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Batch");
      const { resourceGroup, account, application, version } = news;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        applicationName: application,
        versionName: version,
      };
      const get = getPackage(
        subscriptionId,
        resourceGroup,
        account,
        application,
        version,
      );

      // Observe.
      let observed = yield* get;

      // Ensure (and sync tags): the PUT is a synchronous upsert that
      // returns the SAS URL of the package blob.
      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        observed = yield* batch.CreateApplicationPackage({ ...where, tags });
      }

      // Sync content: upload and activate a pending package.
      if (
        news.content !== undefined &&
        observed.properties?.state !== "Active"
      ) {
        const storageUrl = observed.properties?.storageUrl;
        if (storageUrl !== undefined) {
          yield* uploadBlob(storageUrl, version, news.content);
        }
        yield* batch.ActivateApplicationPackage({ ...where, format: "zip" });
      }

      const fresh = yield* waitForProvisioned(
        `batch application package ${application}/${version}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, account, application, version, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        batch.DeleteApplicationPackage({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.account,
          applicationName: output.application,
          versionName: output.version,
        }),
      );
      yield* waitUntilGone(
        `batch application package ${output.application}/${output.version}`,
        getPackage(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.application,
          output.version,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Batch.Application",
        "Azure.Batch.Account",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
