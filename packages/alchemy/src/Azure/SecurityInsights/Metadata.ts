import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  subsetEqual,
} from "./Common.ts";

/** Source of a piece of content. */
export interface MetadataSource {
  /** Source kind: `LocalWorkspace`, `Community`, `Solution`, or `SourceRepository`. */
  kind: "LocalWorkspace" | "Community" | "Solution" | "SourceRepository" | (string & {});
  /**
   * Name of the source (e.g. the solution or repository name). For
   * `LocalWorkspace` it must be the workspace name and defaults to it.
   */
  name?: string;
  /** ID of the source (e.g. the solution ID). */
  sourceId?: string;
}

/** Author of a piece of content. */
export interface MetadataAuthor {
  /** Author name. */
  name?: string;
  /** Author email. */
  email?: string;
  /** Author link. */
  link?: string;
}

/** Support information of a piece of content. */
export interface MetadataSupport {
  /** Support tier: `Microsoft`, `Partner`, or `Community`. */
  tier: "Microsoft" | "Partner" | "Community" | (string & {});
  /** Support contact name. */
  name?: string;
  /** Support email. */
  email?: string;
  /** Support link. */
  link?: string;
}

/** Categories of a piece of content. */
export interface MetadataCategories {
  /** Domains, e.g. `["Security - Threat Protection"]`. */
  domains?: string[];
  /** Industry verticals. */
  verticals?: string[];
}

export interface MetadataProps {
  /** Resource group of the Sentinel workspace. Changing it replaces the metadata. */
  resourceGroup: string;
  /**
   * Sentinel-enabled Log Analytics workspace. Pass `OnboardingState.workspace`
   * so the metadata is created after onboarding. Changing it replaces it.
   */
  workspace: string;
  /**
   * Name of the metadata. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the metadata.
   */
  metadataName?: string;
  /** ARM resource ID of the content described (e.g. `AlertRule.alertRuleResourceId`). */
  parentId: string;
  /** Kind of the content, e.g. `AnalyticsRule`, `Workbook`, `Playbook`. Changing it replaces the metadata. */
  kind: string;
  /** Static ID of the content (e.g. the rule GUID). */
  contentId?: string;
  /** Version of the content (e.g. `1.0.0`). */
  version?: string;
  /** Source of the content. */
  source?: MetadataSource;
  /** Author of the content. */
  author?: MetadataAuthor;
  /** Support information of the content. */
  support?: MetadataSupport;
  /** Categories of the content. */
  categories?: MetadataCategories;
  /** Providers of the content, e.g. `["Microsoft"]`. */
  providers?: string[];
  /** First publish date (`YYYY-MM-DD`). */
  firstPublishDate?: string;
  /** Last publish date (`YYYY-MM-DD`). */
  lastPublishDate?: string;
  /** Customer-provided version of the content. */
  customVersion?: string;
  /** Schema version of the content. */
  contentSchemaVersion?: string;
  /** Icon identifier. */
  icon?: string;
  /** MITRE ATT&CK tactics covered by the content. */
  threatAnalysisTactics?: string[];
  /** MITRE ATT&CK techniques covered by the content. */
  threatAnalysisTechniques?: string[];
  /** Dependencies of the content (`{ operator, criteria: [{ kind, contentId }] }`). */
  dependencies?: Record<string, unknown>;
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
 * Microsoft Sentinel content metadata: links a piece of content (an
 * analytics rule, workbook, playbook, …) to its source, author, version,
 * and support details, as Content Hub solutions do.
 *
 * @see https://learn.microsoft.com/azure/sentinel/sentinel-solutions
 *
 * ### Describing Content
 * **Example:** Version an analytics rule
 * ```typescript
 * const rule = yield* Azure.SecurityInsights.AlertRule("heartbeat", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   displayName: "Missing heartbeat",
 *   severity: "Medium",
 *   query: "Heartbeat | take 1",
 *   queryFrequency: "PT1H",
 *   queryPeriod: "PT1H",
 * });
 * yield* Azure.SecurityInsights.Metadata("heartbeat-metadata", {
 *   resourceGroup: sentinel.resourceGroup,
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
export const Metadata = Resource<Metadata>("Azure.SecurityInsights.Metadata");

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
        (news.metadataName !== undefined &&
          !sameText(news.metadataName, output.metadataName))
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
      const name =
        output?.metadataName ?? olds?.metadataName ?? (yield* createName(id));
      const observed = yield* getMetadata(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      // Ownership follows the workspace.
      return (yield* isWorkspaceOwnedByStack(
        subscriptionId,
        resourceGroup,
        workspace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace } = news;
      const name =
        news.metadataName ?? output?.metadataName ?? (yield* createName(id));
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

      let observed = yield* getMetadata(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      // parentId is an ARM ID: compare it case-insensitively.
      const { parentId, ...rest } = desired;
      if (
        observed === undefined ||
        !sameText(parentId, observed.properties?.parentId) ||
        !subsetEqual(
          rest,
          observed.properties as unknown as Record<string, unknown>,
        )
      ) {
        observed = yield* securityinsights.CreateMetadata({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          metadataName: name,
          etag: observed?.etag,
          properties: desired as unknown as securityinsights.MetadataProperties,
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
        getMetadata(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.metadataName,
        ),
      );
    }),
  });
