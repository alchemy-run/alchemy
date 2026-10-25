import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { compact, isWorkspaceOwnedByStack, SENTINEL_NAMESPACE, sameText } from "./Common.ts";
import type { MetadataAuthor, MetadataSource, MetadataSupport } from "./Metadata.ts";

export interface ContentTemplateProps {
  /**
   * Resource group of the Sentinel workspace. Changing it replaces the template.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Sentinel-enabled Log Analytics workspace. Pass `OnboardingState.workspace`
   * so the template is installed after onboarding. Changing it replaces it.
   */
  workspace: string;
  /**
   * Template ID (the ARM resource name), e.g. the catalog's
   * `<contentProductId>` of the template. Changing it replaces the template.
   */
  templateId: string;
  /** Content ID of the template. */
  contentId: string;
  /** Product ID of the template. */
  contentProductId: string;
  /** Kind of content, e.g. `AnalyticsRule`, `Workbook`, `HuntingQuery`. */
  contentKind: string;
  /** Version of the template. Changing it re-installs that version in place. */
  version: string;
  /** Display name of the template. */
  displayName: string;
  /**
   * ID of the package the template belongs to (`ContentPackage.packageId`).
   * @default not set
   */
  packageId?: string;
  /**
   * Version of the package.
   * @default not set
   */
  packageVersion?: string;
  /**
   * Kind of the package: `Solution` or `Standalone`.
   * @default not set
   */
  packageKind?: "Solution" | "Standalone" | (string & {});
  /**
   * Display name of the package.
   * @default not set
   */
  packageName?: string;
  /** ARM template that deploys the content (the catalog's `packagedContent`). */
  mainTemplate: Record<string, unknown>;
  /**
   * Source of the template.
   * @default not set
   */
  source?: MetadataSource;
  /**
   * Author of the template.
   * @default not set
   */
  author?: MetadataAuthor;
  /**
   * Support information of the template.
   * @default not set
   */
  support?: MetadataSupport;
  /**
   * Schema version of the content.
   * @default not set
   */
  contentSchemaVersion?: string;
}

export interface ContentTemplate extends Resource<
  "Azure.SecurityInsights.ContentTemplate",
  ContentTemplateProps,
  {
    /** Template ID (ARM resource name). */
    templateId: string;
    /** ARM resource ID of the installed template. */
    contentTemplateResourceId: string;
    /** Sentinel workspace of the template. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Content ID of the template. */
    contentId: string | undefined;
    /** Installed version. */
    version: string | undefined;
    /** ETag of the template. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Sentinel content template
 * (`Microsoft.SecurityInsights/contentTemplates`): an analytics rule
 * template, workbook, hunting query, or other content installed in a
 * workspace, usually from a Content Hub package. See the
 * [Azure docs](https://learn.microsoft.com/azure/sentinel/sentinel-solutions-deploy).
 *
 * Copy the fields from the Content Hub catalog (`ListProductTemplates` /
 * `GetProductTemplate`). The catalog's `packagedContent` is the
 * `mainTemplate`.
 *
 * :::caution
 * Onboard the workspace first with `Azure.SecurityInsights.OnboardingState`,
 * and pass its `workspace` attribute so Alchemy creates this resource after
 * the onboarding and deletes it before.
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, or `templateId` replaces the
 * template. Alchemy installs a new `version` and the other fields in place.
 * :::
 *
 * ### Installing Templates
 * **Example:** Install a template of an installed solution
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const sentinel = yield* Azure.SecurityInsights.OnboardingState("sentinel", {
 *   workspace: logs.workspaceName,
 * });
 * const pkg = yield* Azure.SecurityInsights.ContentPackage("azure-activity", {
 *   workspace: sentinel.workspace,
 *   packageId: "azuresentinel.azure-sentinel-solution-azureactivity",
 *   contentId: "azuresentinel.azure-sentinel-solution-azureactivity",
 *   contentProductId: "azuresentinel.azure-sentinel-solution-azureactivity-sl-...",
 *   contentKind: "Solution",
 *   version: "3.0.3",
 *   displayName: "Azure Activity",
 * });
 * yield* Azure.SecurityInsights.ContentTemplate("activity-rule", {
 *   workspace: pkg.workspace,
 *   templateId: "azuresentinel.azure-sentinel-solution-azureactivity-ar-...",
 *   contentId: "<contentId from the catalog>",
 *   contentProductId: "azuresentinel.azure-sentinel-solution-azureactivity-ar-...",
 *   contentKind: "AnalyticsRule",
 *   version: "1.0.0",
 *   displayName: "Azure Activity analytics rule",
 *   packageId: pkg.packageId,
 *   packageKind: "Solution",
 *   mainTemplate: {
 *     $schema:
 *       "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
 *     contentVersion: "1.0.0.0",
 *     resources: [],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ContentTemplate = GroupedResource<ContentTemplate>(
  "Azure.SecurityInsights.ContentTemplate",
);

const getTemplate = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  templateId: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetContentTemplate({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      templateId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  templateId: string,
  template: securityinsights.GetContentTemplateResponse,
): ContentTemplate["Attributes"] => ({
  templateId,
  contentTemplateResourceId: template.id ?? "",
  workspace,
  resourceGroup,
  contentId: template.properties?.contentId,
  version: template.properties?.version,
  etag: template.etag,
});

export const ContentTemplateProvider = () =>
  Provider.succeed(ContentTemplate, {
    stables: ["templateId", "contentTemplateResourceId", "workspace", "resourceGroup"],

    // Templates live inside the workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.templateId, output.templateId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      const templateId = output?.templateId ?? olds?.templateId;
      if (resourceGroup === undefined || workspace === undefined || templateId === undefined) {
        return undefined;
      }
      const observed = yield* getTemplate(subscriptionId, resourceGroup, workspace, templateId);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, templateId, observed);
      // Ownership follows the workspace.
      return (yield* isWorkspaceOwnedByStack(subscriptionId, resourceGroup, workspace))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace, templateId } = news;

      // Observe; (re)install only when the installed record differs in
      // identity, version, or display name.
      let observed = yield* getTemplate(subscriptionId, resourceGroup, workspace, templateId);
      if (
        observed === undefined ||
        observed.properties?.version !== news.version ||
        observed.properties?.displayName !== news.displayName ||
        !sameText(observed.properties?.contentId, news.contentId) ||
        !sameText(observed.properties?.contentProductId, news.contentProductId)
      ) {
        observed = yield* securityinsights.InstallContentTemplate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          templateId,
          etag: observed?.etag,
          properties: compact({
            contentId: news.contentId,
            contentProductId: news.contentProductId,
            contentKind: news.contentKind,
            version: news.version,
            displayName: news.displayName,
            packageId: news.packageId,
            packageVersion: news.packageVersion,
            packageKind: news.packageKind,
            packageName: news.packageName,
            mainTemplate: news.mainTemplate,
            source: news.source,
            author: news.author,
            support: news.support,
            contentSchemaVersion: news.contentSchemaVersion,
          }),
        });
      }
      return toAttrs(resourceGroup, workspace, templateId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.DeleteContentTemplate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          templateId: output.templateId,
        }),
      );
      yield* waitUntilGone(
        `content template ${output.templateId}`,
        getTemplate(subscriptionId, output.resourceGroup, output.workspace, output.templateId),
      );
    }),
  });
