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
  deterministicGuid,
  isWorkspaceOwnedByStack,
  SENTINEL_NAMESPACE,
  sameText,
  subsetEqual,
} from "./Common.ts";

/** Kind of data connector. */
export type DataConnectorKind =
  | "AzureActiveDirectory"
  | "AzureSecurityCenter"
  | "MicrosoftCloudAppSecurity"
  | "ThreatIntelligence"
  | "Office365"
  | "AmazonWebServicesCloudTrail"
  | "AzureAdvancedThreatProtection"
  | "MicrosoftDefenderAdvancedThreatProtection"
  | "MicrosoftThreatIntelligence"
  | "PremiumMicrosoftDefenderForThreatIntelligence"
  | "RestApiPoller"
  | (string & {});

export interface DataConnectorProps {
  /** Resource group of the Sentinel workspace. Changing it replaces the connector. */
  resourceGroup: string;
  /**
   * Sentinel-enabled Log Analytics workspace. Pass `OnboardingState.workspace`
   * so the connector is created after onboarding. Changing it replaces it.
   */
  workspace: string;
  /**
   * Connector ID (a GUID). If omitted, a deterministic GUID is derived from
   * the app, stage, and logical ID. Changing it replaces the connector.
   */
  dataConnectorId?: string;
  /** Kind of connector. Changing it replaces the connector. */
  kind: DataConnectorKind;
  /**
   * Kind-specific connector properties, e.g.
   * `{ dataTypes: { indicators: { state: "Enabled" } } }` for `ThreatIntelligence`.
   * `tenantId` defaults to the deployment's Entra tenant for kinds that need it.
   */
  properties?: Record<string, unknown>;
}

export interface DataConnector extends Resource<
  "Azure.SecurityInsights.DataConnector",
  DataConnectorProps,
  {
    /** Connector ID (GUID). */
    dataConnectorId: string;
    /** ARM resource ID of the connector. */
    dataConnectorResourceId: string;
    /** Kind of the connector. */
    kind: string;
    /** Sentinel workspace of the connector. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ETag of the connector. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Sentinel data connector that streams a source (Microsoft
 * threat intelligence, Defender for Cloud alerts, Microsoft 365, AWS
 * CloudTrail, a Codeless Connector Platform poller, …) into the workspace.
 *
 * Most first-party connector kinds need licenses or consent on the tenant
 * (Microsoft 365 E5, Defender plans), and `MicrosoftThreatIntelligence`
 * needs the tenant approved for Defender TI onboarding; the ARM call fails
 * without them.
 *
 * @see https://learn.microsoft.com/azure/sentinel/connect-data-sources
 *
 * ### Threat Intelligence
 * **Example:** Enable the threat intelligence platforms connector
 * ```typescript
 * const sentinel = yield* Azure.SecurityInsights.OnboardingState("sentinel", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 * });
 * yield* Azure.SecurityInsights.DataConnector("ti", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   kind: "ThreatIntelligence",
 *   properties: { dataTypes: { indicators: { state: "Enabled" } } },
 * });
 * ```
 *
 * ### Defender for Cloud
 * **Example:** Stream Defender for Cloud alerts of a subscription
 * ```typescript
 * yield* Azure.SecurityInsights.DataConnector("defender", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   kind: "AzureSecurityCenter",
 *   properties: {
 *     subscriptionId: "00000000-0000-0000-0000-000000000000",
 *     dataTypes: { alerts: { state: "Enabled" } },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DataConnector = Resource<DataConnector>(
  "Azure.SecurityInsights.DataConnector",
);

/** Kinds whose properties carry the Entra tenant ID. */
const TENANT_KINDS = new Set(
  [
    "AzureActiveDirectory",
    "MicrosoftCloudAppSecurity",
    "ThreatIntelligence",
    "Office365",
    "AzureAdvancedThreatProtection",
    "MicrosoftDefenderAdvancedThreatProtection",
    "MicrosoftThreatIntelligence",
    "PremiumMicrosoftDefenderForThreatIntelligence",
  ].map((k) => k.toLowerCase()),
);

/** Codeless connector kinds that allow many instances per workspace. */
const MULTI_INSTANCE_KINDS = new Set(
  ["RestApiPoller", "GenericUI", "APIPolling"].map((k) => k.toLowerCase()),
);

const getConnector = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  dataConnectorId: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetDataConnector({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dataConnectorId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  connectorId: string,
  connector: securityinsights.GetDataConnectorResponse,
): DataConnector["Attributes"] => ({
  dataConnectorId: connectorId,
  dataConnectorResourceId: connector.id ?? "",
  kind: connector.kind,
  workspace,
  resourceGroup,
  etag: connector.etag,
});

export const DataConnectorProvider = () =>
  Provider.succeed(DataConnector, {
    stables: [
      "dataConnectorId",
      "dataConnectorResourceId",
      "kind",
      "workspace",
      "resourceGroup",
    ],

    // Connectors live inside the workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.kind, output.kind) ||
        (news.dataConnectorId !== undefined &&
          !sameText(news.dataConnectorId, output.dataConnectorId))
      ) {
        // First-party kinds allow one connector per kind and context
        // (tenant/subscription) per workspace, so the old one must go first.
        return {
          action: "replace",
          deleteFirst: !MULTI_INSTANCE_KINDS.has(output.kind.toLowerCase()),
        } as const;
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
      const connectorId =
        output?.dataConnectorId ??
        olds?.dataConnectorId ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getConnector(
        subscriptionId,
        resourceGroup,
        workspace,
        connectorId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, connectorId, observed);
      // Connectors carry no free text: ownership follows the workspace.
      return (yield* isWorkspaceOwnedByStack(
        subscriptionId,
        resourceGroup,
        workspace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId, tenantId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace } = news;
      const connectorId =
        news.dataConnectorId ??
        output?.dataConnectorId ??
        (yield* deterministicGuid(id, instanceId));
      const desired: Record<string, unknown> = {
        ...(TENANT_KINDS.has(news.kind.toLowerCase()) ? { tenantId } : {}),
        ...news.properties,
      };

      let observed = yield* getConnector(
        subscriptionId,
        resourceGroup,
        workspace,
        connectorId,
      );
      if (
        observed === undefined ||
        !subsetEqual(
          desired,
          observed.properties as Record<string, unknown> | undefined,
        )
      ) {
        observed = yield* securityinsights.DataConnectorsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          dataConnectorId: connectorId,
          kind: news.kind as securityinsights.DataConnectorKind,
          etag: observed?.etag,
          properties: desired,
        });
      }
      return toAttrs(resourceGroup, workspace, connectorId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.DeleteDataConnector({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          dataConnectorId: output.dataConnectorId,
        }),
      );
      yield* waitUntilGone(
        `data connector ${output.dataConnectorId}`,
        getConnector(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.dataConnectorId,
        ),
      );
    }),
  });
