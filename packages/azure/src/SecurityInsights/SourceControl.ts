import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  compact,
  deterministicGuid,
  hasOwnMarker,
  isWorkspaceOwnedByStack,
  ownershipMarker,
  SENTINEL_NAMESPACE,
  sameText,
  withMarker,
} from "./Common.ts";

/** Credentials Sentinel uses to access the repository. Write-only. */
export interface SourceControlRepositoryAccess {
  /** Access kind: `OAuth`, `PAT`, or `App` (GitHub App). */
  kind: "OAuth" | "PAT" | "App" | (string & {});
  /**
   * OAuth authorization code (`OAuth`).
   * @default not set
   */
  code?: string | Redacted.Redacted<string>;
  /**
   * OAuth state (`OAuth`).
   * @default not set
   */
  state?: string;
  /**
   * OAuth client ID (`OAuth`).
   * @default not set
   */
  clientId?: string;
  /**
   * Personal access token (`PAT`).
   * @default not set
   */
  token?: string | Redacted.Redacted<string>;
  /**
   * GitHub App installation ID (`App`).
   * @default not set
   */
  installationId?: string;
}

export interface SourceControlProps {
  /**
   * Resource group of the Sentinel workspace. Changing it replaces the connection.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Sentinel-enabled Log Analytics workspace. Pass `OnboardingState.workspace`
   * so the connection is created after onboarding. Changing it replaces it.
   */
  workspace: string;
  /**
   * Source control ID (a GUID). If omitted, a deterministic GUID is derived
   * from the app, stage, and logical ID. Changing it replaces the connection.
   * @default a GUID derived from the app, stage, and logical ID
   */
  sourceControlId?: string;
  /** Display name of the connection. */
  displayName: string;
  /**
   * Description of the connection. An Alchemy ownership marker is appended.
   * @default only the Alchemy ownership marker
   */
  description?: string;
  /** Repository type: `Github` or `AzureDevOps`. Changing it replaces the connection. */
  repoType: "Github" | "AzureDevOps" | (string & {});
  /** Content types deployed from the repository, e.g. `["AnalyticsRule", "Workbook"]`. */
  contentTypes: string[];
  /** Repository URL (changing it replaces the connection) and branch. */
  repository: {
    /** Repository URL. */
    url: string;
    /** Branch to deploy from. */
    branch: string;
    /**
     * URL shown in the portal.
     * @default not set
     */
    displayUrl?: string;
  };
  /** Credentials for the repository. Write-only; only sent on create and when changed. */
  repositoryAccess: SourceControlRepositoryAccess;
  /**
   * Expiry of the service principal credentials Sentinel creates (ISO-8601).
   * @default Azure's default
   */
  servicePrincipalCredentialsExpireOn?: string;
}

export interface SourceControl extends Resource<
  "Azure.SecurityInsights.SourceControl",
  SourceControlProps,
  {
    /** Source control ID (GUID). */
    sourceControlId: string;
    /** ARM resource ID of the connection. */
    sourceControlResourceId: string;
    /** Sentinel workspace of the connection. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Repository URL. */
    repositoryUrl: string;
    /** Repository type. */
    repoType: string;
    /** Version of the connection (`V1` or `V2`). */
    version: string | undefined;
    /** ETag of the connection. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Sentinel repositories connection
 * (`Microsoft.SecurityInsights/sourcecontrols`): it deploys analytics rules,
 * workbooks, playbooks, and other content from a GitHub or Azure DevOps
 * repository branch. Sentinel commits a deployment workflow to the
 * repository. See the
 * [Azure docs](https://learn.microsoft.com/azure/sentinel/ci-cd).
 *
 * :::caution
 * Onboard the workspace first with `Azure.SecurityInsights.OnboardingState`,
 * and pass its `workspace` attribute so Alchemy creates this resource after
 * the onboarding and deletes it before.
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `repoType`, `repository.url`, or
 * `sourceControlId` replaces the connection. Alchemy updates the other props
 * in place, and only sends `repositoryAccess` on create and when it changes.
 * :::
 *
 * ### Connecting Repositories
 * **Example:** Deploy analytics rules from GitHub with a PAT
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const sentinel = yield* Azure.SecurityInsights.OnboardingState("sentinel", {
 *   workspace: logs.workspaceName,
 * });
 * const token = yield* Config.redacted("GITHUB_TOKEN");
 * yield* Azure.SecurityInsights.SourceControl("content-repo", {
 *   workspace: sentinel.workspace,
 *   displayName: "Sentinel content",
 *   repoType: "Github",
 *   contentTypes: ["AnalyticsRule", "AutomationRule"],
 *   repository: { url: "https://github.com/acme/sentinel-content", branch: "main" },
 *   repositoryAccess: { kind: "PAT", token },
 * });
 * ```
 *
 * @resource
 */
export const SourceControl = GroupedResource<SourceControl>("Azure.SecurityInsights.SourceControl");

const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined || typeof value === "string" ? value : Redacted.value(value);

const toAccess = (access: SourceControlRepositoryAccess): securityinsights.RepositoryAccess =>
  compact({
    kind: access.kind,
    code: reveal(access.code),
    state: access.state,
    clientId: access.clientId,
    token: reveal(access.token),
    installationId: access.installationId,
  });

const sameAccess = (
  a: SourceControlRepositoryAccess | undefined,
  b: SourceControlRepositoryAccess | undefined,
) =>
  JSON.stringify(a === undefined ? undefined : toAccess(a)) ===
  JSON.stringify(b === undefined ? undefined : toAccess(b));

const getSourceControl = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  sourceControlId: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetSourceControl({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      sourceControlId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  sourceControlId: string,
  sc: securityinsights.GetSourceControlResponse,
): SourceControl["Attributes"] => ({
  sourceControlId,
  sourceControlResourceId: sc.id ?? "",
  workspace,
  resourceGroup,
  repositoryUrl: sc.properties?.repository.url ?? "",
  repoType: sc.properties?.repoType ?? "",
  version: sc.properties?.version,
  etag: sc.etag,
});

export const SourceControlProvider = () =>
  Provider.succeed(SourceControl, {
    stables: [
      "sourceControlId",
      "sourceControlResourceId",
      "workspace",
      "resourceGroup",
      "repositoryUrl",
      "repoType",
    ],

    // Connections live inside the workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.repoType, output.repoType) ||
        !sameText(news.repository.url, output.repositoryUrl) ||
        (news.sourceControlId !== undefined &&
          !sameText(news.sourceControlId, output.sourceControlId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const scId =
        output?.sourceControlId ??
        olds?.sourceControlId ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getSourceControl(subscriptionId, resourceGroup, workspace, scId);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, scId, observed);
      const owned =
        (yield* isWorkspaceOwnedByStack(subscriptionId, resourceGroup, workspace)) &&
        (yield* hasOwnMarker(id, observed.properties?.description));
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace } = news;
      const scId =
        news.sourceControlId ??
        output?.sourceControlId ??
        (yield* deterministicGuid(id, instanceId));
      const marker = yield* ownershipMarker(id);
      const description = withMarker(news.description, marker);

      let observed = yield* getSourceControl(subscriptionId, resourceGroup, workspace, scId);
      const props = observed?.properties;
      // Credentials are write-only: olds is the only hint they changed.
      const drifted =
        props === undefined ||
        props.displayName !== news.displayName ||
        props.description !== description ||
        props.repository.branch !== news.repository.branch ||
        (news.repository.displayUrl !== undefined &&
          props.repository.displayUrl !== news.repository.displayUrl) ||
        JSON.stringify([...props.contentTypes].sort()) !==
          JSON.stringify([...news.contentTypes].sort()) ||
        !sameAccess(news.repositoryAccess, olds?.repositoryAccess);
      if (observed === undefined || drifted) {
        observed = yield* securityinsights.CreateSourceControl({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          sourceControlId: scId,
          etag: observed?.etag,
          properties: compact({
            displayName: news.displayName,
            description,
            repoType: news.repoType,
            contentTypes: news.contentTypes,
            repository: compact({ ...news.repository }),
            repositoryAccess: toAccess(news.repositoryAccess),
            servicePrincipal:
              news.servicePrincipalCredentialsExpireOn !== undefined
                ? {
                    credentialsExpireOn: news.servicePrincipalCredentialsExpireOn,
                  }
                : undefined,
          }) as securityinsights.SourceControlPropertiesInput,
        });
      }
      return toAttrs(resourceGroup, workspace, scId, observed);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Deleting is a POST action that carries the repository credentials so
      // Sentinel can remove its workflow from the repository.
      yield* ignoreNotFound(
        securityinsights.DeleteSourceControl({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          sourceControlId: output.sourceControlId,
          properties: {
            repositoryAccess: toAccess(olds?.repositoryAccess ?? { kind: "PAT" }),
          },
        }),
      );
      yield* waitUntilGone(
        `source control ${output.sourceControlId}`,
        getSourceControl(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.sourceControlId,
        ),
      );
    }),
  });
