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

export interface DataConnectorDefinitionProps {
  /** Resource group of the Sentinel workspace. Changing it replaces the definition. */
  resourceGroup: string;
  /**
   * Sentinel-enabled Log Analytics workspace. Pass `OnboardingState.workspace`
   * so the definition is created after onboarding. Changing it replaces it.
   */
  workspace: string;
  /**
   * Name of the definition. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the definition.
   */
  dataConnectorDefinitionName?: string;
  /**
   * Kind of definition. Changing it replaces the definition.
   * @default "Customizable"
   */
  kind?: "Customizable" | (string & {});
  /**
   * UI configuration of the connector page: `title`, `publisher`,
   * `descriptionMarkdown`, `graphQueries`, `dataTypes`,
   * `connectivityCriteria`, `permissions`, `instructionSteps`, …
   */
  connectorUiConfig: Record<string, unknown>;
  /** Connections configuration, e.g. `{ templateSpecName: "..." }`. */
  connectionsConfig?: Record<string, unknown>;
}

export interface DataConnectorDefinition extends Resource<
  "Azure.SecurityInsights.DataConnectorDefinition",
  DataConnectorDefinitionProps,
  {
    /** Name of the definition. */
    dataConnectorDefinitionName: string;
    /** ARM resource ID of the definition. */
    dataConnectorDefinitionResourceId: string;
    /** Kind of the definition. */
    kind: string;
    /** Sentinel workspace of the definition. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ETag of the definition. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Codeless Connector Platform (CCP) data connector definition: the
 * connector page shown in Microsoft Sentinel, usually paired with a
 * `DataConnector` of kind `RestApiPoller` that does the polling.
 *
 * @see https://learn.microsoft.com/azure/sentinel/create-codeless-connector
 *
 * ### Codeless Connectors
 * **Example:** Define a connector page
 * ```typescript
 * yield* Azure.SecurityInsights.DataConnectorDefinition("acme", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   connectorUiConfig: {
 *     title: "Acme audit logs",
 *     publisher: "Acme",
 *     descriptionMarkdown: "Streams Acme audit logs into Sentinel.",
 *     graphQueries: [
 *       { metricName: "Total events", legend: "Acme", baseQuery: "AcmeAudit_CL" },
 *     ],
 *     dataTypes: [
 *       { name: "AcmeAudit_CL", lastDataReceivedQuery: "AcmeAudit_CL | summarize Time = max(TimeGenerated)" },
 *     ],
 *     connectivityCriteria: [{ type: "HasDataConnectors" }],
 *     permissions: {},
 *     instructionSteps: [{ title: "Connect", description: "Enter your API key." }],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DataConnectorDefinition = Resource<DataConnectorDefinition>(
  "Azure.SecurityInsights.DataConnectorDefinition",
);

const createName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 }).pipe(
    Effect.map((name) => name.replace(/[^a-zA-Z0-9-]/g, "-")),
  );

const getDefinition = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  dataConnectorDefinitionName: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetDataConnectorDefinition({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dataConnectorDefinitionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  definition: securityinsights.GetDataConnectorDefinitionResponse,
): DataConnectorDefinition["Attributes"] => ({
  dataConnectorDefinitionName: name,
  dataConnectorDefinitionResourceId: definition.id ?? "",
  kind: definition.kind,
  workspace,
  resourceGroup,
  etag: definition.etag,
});

export const DataConnectorDefinitionProvider = () =>
  Provider.succeed(DataConnectorDefinition, {
    stables: [
      "dataConnectorDefinitionName",
      "dataConnectorDefinitionResourceId",
      "kind",
      "workspace",
      "resourceGroup",
    ],

    // Definitions live inside the workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.kind ?? "Customizable", output.kind) ||
        (news.dataConnectorDefinitionName !== undefined &&
          !sameText(
            news.dataConnectorDefinitionName,
            output.dataConnectorDefinitionName,
          ))
      ) {
        return { action: "replace" } as const;
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
        output?.dataConnectorDefinitionName ??
        olds?.dataConnectorDefinitionName ??
        (yield* createName(id));
      const observed = yield* getDefinition(
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
        news.dataConnectorDefinitionName ??
        output?.dataConnectorDefinitionName ??
        (yield* createName(id));
      const desired = compact({
        connectorUiConfig: news.connectorUiConfig,
        connectionsConfig: news.connectionsConfig,
      });

      let observed = yield* getDefinition(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (
        observed === undefined ||
        !subsetEqual(
          desired,
          observed.properties as Record<string, unknown> | undefined,
        )
      ) {
        observed = yield* securityinsights.DataConnectorDefinitionsCreateOrUpdate(
          {
            subscriptionId,
            resourceGroupName: resourceGroup,
            workspaceName: workspace,
            dataConnectorDefinitionName: name,
            kind: (news.kind ??
              "Customizable") as securityinsights.DataConnectorDefinitionKind,
            etag: observed?.etag,
            properties: desired,
          },
        );
      }
      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.DeleteDataConnectorDefinition({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          dataConnectorDefinitionName: output.dataConnectorDefinitionName,
        }),
      );
      yield* waitUntilGone(
        `data connector definition ${output.dataConnectorDefinitionName}`,
        getDefinition(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.dataConnectorDefinitionName,
        ),
      );
    }),
  });
