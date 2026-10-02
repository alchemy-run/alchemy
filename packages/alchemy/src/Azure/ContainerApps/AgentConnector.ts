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

export interface AgentConnectorProps {
  /** Resource group of the agent. Changing it replaces the connector. */
  resourceGroup: string;
  /** Name of the agent. Changing it replaces the connector. */
  agent: string;
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

export interface AgentConnector extends Resource<
  "Azure.ContainerApps.AgentConnector",
  AgentConnectorProps,
  {
    /** Name of the connector. */
    connectorName: string;
    /** ARM resource ID of the connector. */
    connectorId: string;
    /** Name of the agent. */
    agent: string;
    /** Resource group of the agent. */
    resourceGroup: string;
    /** Data connector type. */
    dataConnectorType: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A data connector of an Azure SRE Agent (`Microsoft.App/agents/connectors`)
 * — a telemetry source (Kusto, Application Insights, ...) the agent can
 * query during investigations.
 *
 * Connectors cannot be tagged; Alchemy treats a connector as owned when its
 * agent is owned by the same stack and stage.
 *
 * ### Connecting Data Sources
 * **Example:** Kusto cluster connector
 * ```typescript
 * yield* Azure.ContainerApps.AgentConnector("kusto", {
 *   resourceGroup: group.resourceGroupName,
 *   agent: agent.agentName,
 *   dataConnectorType: "Kusto",
 *   dataSource: "https://mycluster.westus2.kusto.windows.net",
 *   identity: "system",
 * });
 * ```
 *
 * @resource
 */
export const AgentConnector = Resource<AgentConnector>(
  "Azure.ContainerApps.AgentConnector",
);

const createConnectorName = (id: string) => createContainerAppsName(id, 32);

const getConnector = (
  subscriptionId: string,
  resourceGroupName: string,
  agentName: string,
  connectorName: string,
) =>
  orUndefinedIfNotFound(
    app.GetAgentsConnector({
      subscriptionId,
      resourceGroupName,
      agentName,
      connectorName,
    }),
  );

/** Whether the agent is tagged as owned by the current stack. */
const isParentOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  agentName: string,
) {
  const parent = yield* orUndefinedIfNotFound(
    app.GetAgent({ subscriptionId, resourceGroupName, agentName }),
  );
  return parent !== undefined && (yield* taggedByStack(parent.tags));
});

const toAttrs = (
  resourceGroup: string,
  agent: string,
  name: string,
  observed: app.GetAgentsConnectorResponse,
): AgentConnector["Attributes"] => ({
  connectorName: name,
  connectorId: observed.id ?? "",
  agent,
  resourceGroup,
  dataConnectorType: observed.properties?.dataConnectorType,
});

const toProperties = (props: AgentConnectorProps) => ({
  dataConnectorType: props.dataConnectorType,
  dataSource: props.dataSource,
  endpoint: props.endpoint,
  identity: props.identity,
  extendedProperties: props.extendedProperties,
});

export const AgentConnectorProvider = () =>
  Provider.succeed(AgentConnector, {
    stables: ["connectorName", "connectorId", "agent", "resourceGroup"],

    // Lives inside an agent; nuke removes it with the agent.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.agent !== output.agent ||
        (news.name !== undefined && news.name !== output.connectorName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const agent = output?.agent ?? olds?.agent;
      if (resourceGroup === undefined || agent === undefined) return undefined;
      const name =
        output?.connectorName ?? olds?.name ?? (yield* createConnectorName(id));
      const observed = yield* getConnector(
        subscriptionId,
        resourceGroup,
        agent,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, agent, name, observed);
      return (yield* isParentOwnedByStack(subscriptionId, resourceGroup, agent))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, agent } = news;
      const name =
        news.name ?? output?.connectorName ?? (yield* createConnectorName(id));
      const properties = toProperties(news);
      const get = getConnector(subscriptionId, resourceGroup, agent, name);
      const ready = waitForProvisioned(
        `agent connector ${name}`,
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
        yield* app.AgentsConnectorsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          agentName: agent,
          connectorName: name,
          properties,
        });
      }
      observed = yield* ready;

      return toAttrs(resourceGroup, agent, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteAgentsConnector({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          agentName: output.agent,
          connectorName: output.connectorName,
        }),
      );
      yield* waitUntilGone(
        `agent connector ${output.connectorName}`,
        getConnector(
          subscriptionId,
          output.resourceGroup,
          output.agent,
          output.connectorName,
        ),
      );
    }),
  });
