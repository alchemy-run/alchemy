import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
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
import {
  createContainerAppsName,
  fingerprint,
  lower,
  matchesDesired,
  taggedByStack,
} from "./common.ts";

export interface AgentSpaceConnectorProps {
  /** Resource group of the agent space. Changing it replaces the connector. */
  resourceGroup: string;
  /** Name of the agent space. Changing it replaces the connector. */
  agentSpace: string;
  /**
   * Connector name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the connector.
   */
  name?: string;
  /** Data connector type, e.g. `Kusto` or `AppInsights`. */
  dataConnectorType: string;
  /** Data source connection string or endpoint. */
  dataSource?: string;
  /** Endpoint of the connector. */
  endpoint?: string;
  /** Identity used to access the data source (`system` or a user identity ARM ID). */
  identity?: string;
  /** Additional connector settings. */
  extendedProperties?: Record<string, unknown>;
}

export interface AgentSpaceConnector extends Resource<
  "Azure.ContainerApps.AgentSpaceConnector",
  AgentSpaceConnectorProps,
  {
    /** Name of the connector. */
    connectorName: string;
    /** ARM resource ID of the connector. */
    connectorId: string;
    /** Name of the agent space. */
    agentSpace: string;
    /** Resource group of the agent space. */
    resourceGroup: string;
    /** Data connector type. */
    dataConnectorType: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A data connector shared by every agent of an Azure SRE agent space
 * (`Microsoft.App/agentSpaces/connectors`) — a telemetry source (Kusto,
 * Application Insights, ...) member agents inherit.
 *
 * Connectors cannot be tagged; Alchemy treats a connector as owned when its
 * agent space is owned by the same stack and stage.
 *
 * ### Connecting Data Sources
 * **Example:** Kusto connector shared by a space
 * ```typescript
 * yield* Azure.ContainerApps.AgentSpaceConnector("kusto", {
 *   resourceGroup: group.resourceGroupName,
 *   agentSpace: space.agentSpaceName,
 *   dataConnectorType: "Kusto",
 *   dataSource: "https://mycluster.westus2.kusto.windows.net",
 * });
 * ```
 *
 * @resource
 */
export const AgentSpaceConnector = Resource<AgentSpaceConnector>(
  "Azure.ContainerApps.AgentSpaceConnector",
);

const createConnectorName = (id: string) => createContainerAppsName(id, 32);

const getConnector = (
  subscriptionId: string,
  resourceGroupName: string,
  agentSpaceName: string,
  connectorName: string,
) =>
  orUndefinedIfNotFound(
    app.GetAgentSpacesConnector({
      subscriptionId,
      resourceGroupName,
      agentSpaceName,
      connectorName,
    }),
  );

/** Whether the agent space is tagged as owned by the current stack. */
const isParentOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  agentSpaceName: string,
) {
  const parent = yield* orUndefinedIfNotFound(
    app.GetAgentSpace({ subscriptionId, resourceGroupName, agentSpaceName }),
  );
  return parent !== undefined && (yield* taggedByStack(parent.tags));
});

const toAttrs = (
  resourceGroup: string,
  agentSpace: string,
  name: string,
  observed: app.GetAgentSpacesConnectorResponse,
): AgentSpaceConnector["Attributes"] => ({
  connectorName: name,
  connectorId: observed.id ?? "",
  agentSpace,
  resourceGroup,
  dataConnectorType: observed.properties?.dataConnectorType,
});

const toProperties = (props: AgentSpaceConnectorProps) => ({
  dataConnectorType: props.dataConnectorType,
  dataSource: props.dataSource,
  endpoint: props.endpoint,
  identity: props.identity,
  extendedProperties: props.extendedProperties,
});

export const AgentSpaceConnectorProvider = () =>
  Provider.succeed(AgentSpaceConnector, {
    stables: ["connectorName", "connectorId", "agentSpace", "resourceGroup"],

    // Lives inside an agent space; nuke removes it with the space.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.agentSpace !== output.agentSpace ||
        (news.name !== undefined && news.name !== output.connectorName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const agentSpace = output?.agentSpace ?? olds?.agentSpace;
      if (resourceGroup === undefined || agentSpace === undefined)
        return undefined;
      const name =
        output?.connectorName ?? olds?.name ?? (yield* createConnectorName(id));
      const observed = yield* getConnector(
        subscriptionId,
        resourceGroup,
        agentSpace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, agentSpace, name, observed);
      return (yield* isParentOwnedByStack(
        subscriptionId,
        resourceGroup,
        agentSpace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, agentSpace } = news;
      const name =
        news.name ?? output?.connectorName ?? (yield* createConnectorName(id));
      const properties = toProperties(news);
      const get = getConnector(subscriptionId, resourceGroup, agentSpace, name);
      const ready = waitForProvisioned(
        `agent space connector ${name}`,
        get,
        (connector) => connector.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync: one full PUT, skipped when nothing changed.
      if (
        observed === undefined ||
        !matchesDesired(properties, observed.properties) ||
        (olds !== undefined &&
          fingerprint(properties) !== fingerprint(toProperties(olds)))
      ) {
        yield* app.AgentSpacesConnectorsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          agentSpaceName: agentSpace,
          connectorName: name,
          properties,
        });
      }
      observed = yield* ready;

      return toAttrs(resourceGroup, agentSpace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteAgentSpacesConnector({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          agentSpaceName: output.agentSpace,
          connectorName: output.connectorName,
        }),
      );
      yield* waitUntilGone(
        `agent space connector ${output.connectorName}`,
        getConnector(
          subscriptionId,
          output.resourceGroup,
          output.agentSpace,
          output.connectorName,
        ),
      );
    }),
  });
