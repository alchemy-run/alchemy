import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  compact,
  isWorkspaceOwnedByStack,
  SENTINEL_NAMESPACE,
  sameText,
  subsetEqual,
} from "./Common.ts";

/** Source of a piece of content. */
export interface MetadataSource {
  /** Source kind: `LocalWorkspace`, `Community`, `Solution`, or `SourceRepository`. */
  kind: "LocalWorkspace" | "Community" | "Solution" | "SourceRepository" | (string & {});
  /**
   * Name of the source (e.g. the solution or repository name). For
   * `LocalWorkspace` it must be the workspace name and defaults to it.
   * @default the workspace name for `LocalWorkspace`, else not set
   */
  name?: string;
  /**
   * ID of the source (e.g. the solution ID).
   * @default not set
   */
  sourceId?: string;
}

/** Author of a piece of content. */
export interface MetadataAuthor {
  /**
   * Author name.
   * @default not set
   */
  name?: string;
  /**
   * Author email.
   * @default not set
   */
  email?: string;
  /**
   * Author link.
   * @default not set
   */
  link?: string;
}

/** Support information of a piece of content. */
export interface MetadataSupport {
  /** Support tier: `Microsoft`, `Partner`, or `Community`. */
  tier: "Microsoft" | "Partner" | "Community" | (string & {});
  /**
   * Support contact name.
   * @default not set
   */
  name?: string;
  /**
   * Support email.
   * @default not set
   */
  email?: string;
  /**
   * Support link.
   * @default not set
   */
  link?: string;
}

/** Categories of a piece of content. */
export interface MetadataCategories {
  /**
   * Domains, e.g. `["Security - Threat Protection"]`.
   * @default []
   */
  domains?: string[];
  /**
   * Industry verticals.
   * @default []
   */
  verticals?: string[];
}

/**
 * A dependency of a piece of content: one item (`kind` + `contentId`), or
 * an `operator` over a list of `criteria`.
 */
export interface MetadataDependency {
  /**
   * Static ID of the content depended on.
   * @default not set
   */
  contentId?: string;
  /**
   * Kind of the content depended on, e.g. `DataConnector`.
   * @default not set
   */
  kind?: string;
  /**
   * Version required; blank or `*` accepts any version.
   * @default not set
   */
  version?: string;
  /**
   * Name of the content depended on.
   * @default not set
   */
  name?: string;
  /**
   * How `criteria` combine: `AND` or `OR`.
   * @default not set
   */
  operator?: "AND" | "OR" | (string & {});
  /**
   * Dependencies combined by `operator`.
   * @default not set
   */
  criteria?: MetadataDependency[];
}

export interface MetadataProps {
  /**
   * Resource group of the Sentinel workspace. Changing it replaces the metadata.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Sentinel-enabled Log Analytics workspace. Pass `OnboardingState.workspace`
   * so the metadata is created after onboarding. Changing it replaces it.
   */
  workspace: string;
  /**
   * Name of the metadata. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the metadata.
   * @default a unique name generated from the app, stage, and logical ID
   */
  metadataName?: string;
  /** ARM resource ID of the content described (e.g. `AlertRule.alertRuleResourceId`). */
  parentId: string;
  /** Kind of the content, e.g. `AnalyticsRule`, `Workbook`, `Playbook`. Changing it replaces the metadata. */
  kind: string;
  /**
   * Static ID of the content (e.g. the rule GUID).
   * @default not set
   */
  contentId?: string;
  /**
   * Version of the content (e.g. `1.0.0`).
   * @default not set
   */
  version?: string;
  /**
   * Source of the content.
   * @default not set
   */
  source?: MetadataSource;
  /**
   * Author of the content.
   * @default not set
   */
  author?: MetadataAuthor;
  /**
   * Support information of the content.
   * @default not set
   */
  support?: MetadataSupport;
  /**
   * Categories of the content.
   * @default not set
   */
  categories?: MetadataCategories;
  /**
   * Providers of the content, e.g. `["Microsoft"]`.
   * @default not set
   */
  providers?: string[];
  /**
   * First publish date (`YYYY-MM-DD`).
   * @default not set
   */
  firstPublishDate?: string;
  /**
   * Last publish date (`YYYY-MM-DD`).
   * @default not set
   */
  lastPublishDate?: string;
  /**
   * Customer-provided version of the content.
   * @default not set
   */
  customVersion?: string;
  /**
   * Schema version of the content.
   * @default not set
   */
  contentSchemaVersion?: string;
  /**
   * Icon identifier.
   * @default not set
   */
  icon?: string;
  /**
   * MITRE ATT&CK tactics covered by the content.
   * @default not set
   */
  threatAnalysisTactics?: string[];
  /**
   * MITRE ATT&CK techniques covered by the content.
   * @default not set
   */
  threatAnalysisTechniques?: string[];
  /**
   * Dependencies of the content (`{ operator, criteria: [{ kind, contentId }] }`).
   * @default not set
   */
  dependencies?: MetadataDependency;
}

export interface Metadata extends Resource<
  "Azure.SecurityInsights.Metadata",
  MetadataProps,
  {
    /** Name of the metadata. */
    metadataName: string;
    /** ARM resource ID of the metadata. */
    metadataResourceId: string;
    /** Sentinel workspace of the metadata. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Kind of the content described. */
    kind: string;
    /** ARM resource ID of the content described. */
    parentId: string;
    /** Version of the content. */
    version: string | undefined;
    /** ETag of the metadata. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Microsoft Sentinel content metadata
 * (`Microsoft.SecurityInsights/metadata`): it links a piece of content (an
 * analytics rule, workbook, playbook, and so on) to its source, author,
 * version, and support details, as Content Hub solutions do. See the
 * [Azure docs](https://learn.microsoft.com/azure/sentinel/sentinel-solutions).
 *
 * :::caution
 * Onboard the workspace first with `Azure.SecurityInsights.OnboardingState`,
 * and pass its `workspace` attribute so Alchemy creates this resource after
 * the onboarding and deletes it before.
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `kind`, or `metadataName` replaces
 * the metadata. Azure allows one metadata per `parentId`, so Alchemy deletes
 * the old metadata first when the parent stays the same. Alchemy updates
 * every other prop in place.
 * :::
 *
 * ### Describing Content
 * **Example:** Version an analytics rule
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const sentinel = yield* Azure.SecurityInsights.OnboardingState("sentinel", {
 *   workspace: logs.workspaceName,
 * });
 * const rule = yield* Azure.SecurityInsights.AlertRule("heartbeat", {
 *   workspace: sentinel.workspace,
 *   displayName: "Missing heartbeat",
 *   severity: "Medium",
 *   query: "Heartbeat | take 1",
 *   queryFrequency: "PT1H",
 *   queryPeriod: "PT1H",
 * });
 * yield* Azure.SecurityInsights.Metadata("heartbeat-metadata", {
 *   workspace: sentinel.workspace,
 *   kind: "AnalyticsRule",
 *   parentId: rule.alertRuleResourceId,
 *   contentId: rule.ruleId,
 *   version: "1.0.0",
 *   source: { kind: "LocalWorkspace" },
 *   author: { name: "Platform team" },
 *   support: { tier: "Community" },
 * });
 * ```
 *
 * @resource
 */
export const Metadata = GroupedResource<Metadata>("Azure.SecurityInsights.Metadata");

const createName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 }).pipe(
    Effect.map((name) => name.replace(/[^a-zA-Z0-9-]/g, "-")),
  );

const getMetadata = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  metadataName: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetMetadata({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      metadataName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  metadata: securityinsights.GetMetadataResponse,
): Metadata["Attributes"] => ({
  metadataName: name,
  metadataResourceId: metadata.id ?? "",
  workspace,
  resourceGroup,
  kind: metadata.properties?.kind ?? "",
  parentId: metadata.properties?.parentId ?? "",
  version: metadata.properties?.version,
  etag: metadata.etag,
});

export const MetadataProvider = () =>
  Provider.succeed(Metadata, {
    stables: ["metadataName", "metadataResourceId", "workspace", "resourceGroup"],

    // Metadata lives inside the workspace; nuke removes it with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.kind, output.kind) ||
        (news.metadataName !== undefined && !sameText(news.metadataName, output.metadataName))
      ) {
        // Azure allows one metadata per parentId, so a replacement that keeps
        // the parent must delete the old metadata first.
        return {
          action: "replace",
          deleteFirst: sameText(news.parentId, output.parentId),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name = output?.metadataName ?? olds?.metadataName ?? (yield* createName(id));
      const observed = yield* getMetadata(subscriptionId, resourceGroup, workspace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      // Ownership follows the workspace.
      return (yield* isWorkspaceOwnedByStack(subscriptionId, resourceGroup, workspace))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace } = news;
      const name = news.metadataName ?? output?.metadataName ?? (yield* createName(id));
      const desired = compact({
        parentId: news.parentId,
        kind: news.kind,
        contentId: news.contentId,
        version: news.version,
        // A LocalWorkspace source must be named after the workspace.
        source:
          news.source !== undefined &&
          sameText(news.source.kind, "LocalWorkspace") &&
          news.source.name === undefined
            ? { ...news.source, name: workspace }
            : news.source,
        author: news.author,
        support: news.support,
        categories: news.categories,
        providers: news.providers,
        firstPublishDate: news.firstPublishDate,
        lastPublishDate: news.lastPublishDate,
        customVersion: news.customVersion,
        contentSchemaVersion: news.contentSchemaVersion,
        icon: news.icon,
        threatAnalysisTactics: news.threatAnalysisTactics,
        threatAnalysisTechniques: news.threatAnalysisTechniques,
        dependencies: news.dependencies,
      });

      let observed = yield* getMetadata(subscriptionId, resourceGroup, workspace, name);
      // parentId is an ARM ID: compare it case-insensitively.
      const { parentId, ...rest } = desired;
      if (
        observed === undefined ||
        !sameText(parentId, observed.properties?.parentId) ||
        !subsetEqual(rest, observed.properties)
      ) {
        observed = yield* securityinsights.CreateMetadata({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          metadataName: name,
          etag: observed?.etag,
          properties: desired,
        });
      }
      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.DeleteMetadata({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          metadataName: output.metadataName,
        }),
      );
      yield* waitUntilGone(
        `metadata ${output.metadataName}`,
        getMetadata(subscriptionId, output.resourceGroup, output.workspace, output.metadataName),
      );
    }),
  });
