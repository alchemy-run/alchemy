import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  compact,
  isWorkspaceOwnedByStack,
  SENTINEL_NAMESPACE,
  sameText,
} from "./Common.ts";
import type {
  MetadataAuthor,
  MetadataCategories,
  MetadataSource,
  MetadataSupport,
} from "./Metadata.ts";

export interface ContentPackageProps {
  /** Resource group of the Sentinel workspace. Changing it replaces the package. */
  resourceGroup: string;
  /**
   * Sentinel-enabled Log Analytics workspace. Pass `OnboardingState.workspace`
   * so the package is installed after onboarding. Changing it replaces it.
   */
  workspace: string;
  /**
   * Package ID (the ARM resource name). Content Hub uses the package's
   * `contentId`, e.g. `azuresentinel.azure-sentinel-solution-azureactivity`.
   * Changing it replaces the package.
   */
  packageId: string;
  /** Content ID of the package (from the Content Hub catalog). */
  contentId: string;
  /** Product ID of the package (from the Content Hub catalog). */
  contentProductId: string;
  /** Package kind: `Solution` or `Standalone`. */
  contentKind: "Solution" | "Standalone" | (string & {});
  /** Version to install. Changing it re-installs that version in place. */
  version: string;
  /** Display name of the package. */
  displayName: string;
  /** Description of the package. */
  description?: string;
  /** Publisher display name. */
  publisherDisplayName?: string;
  /** Source of the package. */
  source?: MetadataSource;
  /** Author of the package. */
  author?: MetadataAuthor;
  /** Support information of the package. */
  support?: MetadataSupport;
  /** Categories of the package. */
  categories?: MetadataCategories;
  /** Providers of the package. */
  providers?: string[];
  /** First publish date (`YYYY-MM-DD`). */
  firstPublishDate?: string;
  /** Last publish date (`YYYY-MM-DD`). */
  lastPublishDate?: string;
  /** Schema version of the package. */
  contentSchemaVersion?: string;
  /** Icon identifier. */
  icon?: string;
}

export interface ContentPackage extends Resource<
  "Azure.SecurityInsights.ContentPackage",
  ContentPackageProps,
  {
    /** Package ID (ARM resource name). */
    packageId: string;
    /** ARM resource ID of the installed package. */
    contentPackageResourceId: string;
    /** Sentinel workspace of the package. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Content ID of the package. */
    contentId: string | undefined;
    /** Installed version. */
    version: string | undefined;
    /** ETag of the package. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Sentinel Content Hub package (solution or standalone content)
 * installed in a workspace. Installing records the package; its content
 * (analytics rule templates, workbooks, …) is installed with
 * `ContentTemplate`.
 *
 * The package fields are copied from the Content Hub catalog
 * (`ListProductPackages` / `GetProductPackage`).
 *
 * @see https://learn.microsoft.com/azure/sentinel/sentinel-solutions-deploy
 *
 * ### Installing Solutions
 * **Example:** Install the Azure Activity solution
 * ```typescript
 * yield* Azure.SecurityInsights.ContentPackage("azure-activity", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   packageId: "azuresentinel.azure-sentinel-solution-azureactivity",
 *   contentId: "azuresentinel.azure-sentinel-solution-azureactivity",
 *   contentProductId: "azuresentinel.azure-sentinel-solution-azureactivity-sl-...",
 *   contentKind: "Solution",
 *   version: "3.0.3",
 *   displayName: "Azure Activity",
 * });
 * ```
 *
 * @resource
 */
export const ContentPackage = Resource<ContentPackage>(
  "Azure.SecurityInsights.ContentPackage",
);

const getPackage = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  packageId: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetContentPackage({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      packageId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  packageId: string,
  pkg: securityinsights.GetContentPackageResponse,
): ContentPackage["Attributes"] => ({
  packageId,
  contentPackageResourceId: pkg.id ?? "",
  workspace,
  resourceGroup,
  contentId: pkg.properties?.contentId,
  version: pkg.properties?.version,
  etag: pkg.etag,
});

export const ContentPackageProvider = () =>
  Provider.succeed(ContentPackage, {
    stables: ["packageId", "contentPackageResourceId", "workspace", "resourceGroup"],

    // Packages live inside the workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.packageId, output.packageId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      const packageId = output?.packageId ?? olds?.packageId;
      if (
        resourceGroup === undefined ||
        workspace === undefined ||
        packageId === undefined
      ) {
        return undefined;
      }
      const observed = yield* getPackage(
        subscriptionId,
        resourceGroup,
        workspace,
        packageId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, packageId, observed);
      // Ownership follows the workspace.
      return (yield* isWorkspaceOwnedByStack(
        subscriptionId,
        resourceGroup,
        workspace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace, packageId } = news;

      // Observe; (re)install only when the installed record differs in
      // identity, version, or display name. Other catalog fields are not
      // compared.
      let observed = yield* getPackage(
        subscriptionId,
        resourceGroup,
        workspace,
        packageId,
      );
      if (
        observed === undefined ||
        observed.properties?.version !== news.version ||
        observed.properties?.displayName !== news.displayName ||
        !sameText(observed.properties?.contentId, news.contentId) ||
        !sameText(observed.properties?.contentProductId, news.contentProductId)
      ) {
        observed = yield* securityinsights.InstallContentPackage({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          packageId,
          etag: observed?.etag,
          properties: compact({
            contentId: news.contentId,
            contentProductId: news.contentProductId,
            contentKind: news.contentKind,
            version: news.version,
            displayName: news.displayName,
            description: news.description,
            publisherDisplayName: news.publisherDisplayName,
            source: news.source,
            author: news.author,
            support: news.support,
            categories: news.categories,
            providers: news.providers,
            firstPublishDate: news.firstPublishDate,
            lastPublishDate: news.lastPublishDate,
            contentSchemaVersion: news.contentSchemaVersion,
            icon: news.icon,
          }),
        });
      }
      return toAttrs(resourceGroup, workspace, packageId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.UninstallContentPackage({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          packageId: output.packageId,
        }),
      );
      yield* waitUntilGone(
        `content package ${output.packageId}`,
        getPackage(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.packageId,
        ),
      );
    }),
  });
