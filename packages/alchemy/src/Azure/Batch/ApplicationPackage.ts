import * as batch from "@distilled.cloud/azure/batch";
import { createHash } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { accountOwnedByStage } from "./Common.ts";

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
   * it yourself. Changing it re-uploads and re-activates the package, which
   * Azure only allows when the application has `allowUpdates` enabled.
   */
  content?: string;
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
    /** SHA-256 of the last `content` Alchemy uploaded. */
    contentHash: string | undefined;
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
 * package activated during deploy. Packages cannot be tagged; a package
 * counts as owned when its Batch account carries this stack's and stage's
 * ownership tags.
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
  ).pipe(
    // No application can exist on an account without auto-storage.
    Effect.catchTag("BatchAccountNotEnabledForAutoStorage", () =>
      Effect.succeed(undefined),
    ),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  application: string,
  version: string,
  pkg: ObservedPackage,
  contentHash: string | undefined,
): ApplicationPackage["Attributes"] => ({
  packageId: pkg.id ?? "",
  version,
  application,
  account,
  resourceGroup,
  state: pkg.properties?.state,
  format: pkg.properties?.format,
  lastActivationTime: pkg.properties?.lastActivationTime,
  contentHash,
});

const hashContent = (content: string) =>
  Effect.sync(() => createHash("sha256").update(content).digest("hex"));

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

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        news.application.toLowerCase() !== output.application.toLowerCase() ||
        news.version !== output.version
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
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
        output?.contentHash,
      );
      return (yield* accountOwnedByStage(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Batch");
      const { resourceGroup, account, application, version } = news;
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

      // Content to sync: a pending package, or content that differs from
      // what was last uploaded.
      const contentHash =
        news.content !== undefined
          ? yield* hashContent(news.content)
          : output?.contentHash;
      const needsUpload =
        news.content !== undefined &&
        (observed?.properties?.state !== "Active" ||
          output?.contentHash !== contentHash);

      // Ensure: the PUT is synchronous and returns a fresh SAS URL for the
      // package blob (GET does not always include one).
      if (observed === undefined || needsUpload) {
        observed = yield* batch.CreateApplicationPackage(where);
      }

      // Sync content: upload the zip and activate it.
      if (needsUpload && news.content !== undefined) {
        const storageUrl = observed.properties?.storageUrl;
        if (storageUrl === undefined) {
          return yield* new ApplicationPackageUploadFailed({
            version,
            status: 0,
            message: `Azure returned no storage URL for application package ${application}/${version}`,
          });
        }
        yield* uploadBlob(storageUrl, version, news.content);
        yield* batch.ActivateApplicationPackage({ ...where, format: "zip" });
      }

      const fresh = yield* waitForProvisioned(
        `batch application package ${application}/${version}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(
        resourceGroup,
        account,
        application,
        version,
        fresh,
        contentHash,
      );
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
      ).pipe(
        Effect.catchTag(
          "BatchAccountNotEnabledForAutoStorage",
          () => Effect.void,
        ),
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
