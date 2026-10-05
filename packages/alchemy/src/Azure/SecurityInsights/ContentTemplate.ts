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
  MetadataSource,
  MetadataSupport,
} from "./Metadata.ts";

export interface ContentTemplateProps {
  /** Resource group of the Sentinel workspace. Changing it replaces the template. */
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
  /** ID of the package the template belongs to (`ContentPackage.packageId`). */
  packageId?: string;
  /** Version of the package. */
  packageVersion?: string;
  /** Kind of the package: `Solution` or `Standalone`. */
  packageKind?: "Solution" | "Standalone" | (string & {});
  /** Display name of the package. */
  packageName?: string;
  /** ARM template that deploys the content (the catalog's `packagedContent`). */
  mainTemplate: Record<string, unknown>;
  /** Source of the template. */
  source?: MetadataSource;
  /** Author of the template. */
  author?: MetadataAuthor;
  /** Support information of the template. */
  support?: MetadataSupport;
  /** Schema version of the content. */
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
 * A Microsoft Sentinel content template (analytics rule template, workbook,
 * hunting query, …) installed in a workspace, usually from a Content Hub
 * package. The fields are copied from the Content Hub catalog
 * (`ListProductTemplates` / `GetProductTemplate`, whose `packagedContent`
 * is the `mainTemplate`).
 *
 * @see https://learn.microsoft.com/azure/sentinel/sentinel-solutions-deploy
 *
 * ### Installing Templates
 * **Example:** Install a template of an installed solution
 * ```typescript
 * const pkg = yield* Azure.SecurityInsights.ContentPackage("azure-activity", {
 *   // ... fields from the Content Hub catalog
 * });
 * yield* Azure.SecurityInsights.ContentTemplate("activity-rule", {
 *   resourceGroup: pkg.resourceGroup,
 *   workspace: pkg.workspace,
 *   templateId: catalogTemplate.name,
 *   contentId: catalogTemplate.properties.contentId,
 *   contentProductId: catalogTemplate.properties.contentProductId,
 *   contentKind: "AnalyticsRule",
 *   version: catalogTemplate.properties.version,
 *   displayName: catalogTemplate.properties.displayName,
 *   packageId: pkg.packageId,
 *   packageKind: "Solution",
 *   mainTemplate: catalogTemplate.properties.packagedContent,
 * });
 * ```
 *
 * @resource
 */
export const ContentTemplate = Resource<ContentTemplate>(
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
    stables: [
      "templateId",
      "contentTemplateResourceId",
      "workspace",
      "resourceGroup",
    ],

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
      if (
        resourceGroup === undefined ||
        workspace === undefined ||
        templateId === undefined
      ) {
        return undefined;
      }
      const observed = yield* getTemplate(
        subscriptionId,
        resourceGroup,
        workspace,
        templateId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, templateId, observed);
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
      const { resourceGroup, workspace, templateId } = news;

      // Observe; (re)install only when the installed record differs in
      // identity, version, or display name.
      let observed = yield* getTemplate(
        subscriptionId,
        resourceGroup,
        workspace,
        templateId,
      );
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
        getTemplate(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.templateId,
        ),
      );
    }),
  });
