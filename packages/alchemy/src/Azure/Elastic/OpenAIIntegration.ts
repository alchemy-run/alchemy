import * as elastic from "@distilled.cloud/azure/elastic";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  isMonitorOwnedByStack,
  type MonitorChildProps,
  sameName,
} from "./common.ts";

export interface OpenAIIntegrationProps extends MonitorChildProps {
  /**
   * Name of the integration. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the integration.
   */
  name?: string;
  /**
   * ARM resource ID of the Azure OpenAI (Cognitive Services) account whose
   * usage Elastic monitors.
   */
  openAIResourceId: string;
  /** API endpoint of the Azure OpenAI account, e.g. `https://my-openai.openai.azure.com/`. */
  openAIResourceEndpoint: string;
  /** API key of the Azure OpenAI account. */
  key: Redacted.Redacted<string>;
}

export interface OpenAIIntegration extends Resource<
  "Azure.Elastic.OpenAIIntegration",
  OpenAIIntegrationProps,
  {
    /** Name of the Elastic monitor. */
    monitor: string;
    /** Resource group of the monitor. */
    resourceGroup: string;
    /** Name of the integration. */
    integrationName: string;
    /** ARM resource ID of the integration. */
    integrationId: string;
    /** ARM resource ID of the Azure OpenAI account. */
    openAIResourceId: string | undefined;
    /** API endpoint of the Azure OpenAI account. */
    openAIResourceEndpoint: string | undefined;
    /** ID of the Elastic connector created for the OpenAI account. */
    openAIConnectorId: string | undefined;
    /** When the API key was last refreshed. */
    lastRefreshAt: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure OpenAI integration of an Elastic monitor
 * (`Microsoft.Elastic/monitors/openAIIntegrations`). Elastic creates a
 * connector to the Azure OpenAI account so Elastic AI Assistant and LLM
 * observability can use it.
 *
 * ### Connecting Azure OpenAI
 * **Example:** Connect an Azure OpenAI account to Elastic
 * ```typescript
 * const integration = yield* Azure.Elastic.OpenAIIntegration("openai", {
 *   resourceGroup: group.resourceGroupName,
 *   monitor: monitor.monitorName,
 *   openAIResourceId: account.accountId,
 *   openAIResourceEndpoint: account.endpoint,
 *   key: Redacted.make(process.env.AZURE_OPENAI_KEY!),
 * });
 * ```
 *
 * @resource
 */
export const OpenAIIntegration = Resource<OpenAIIntegration>(
  "Azure.Elastic.OpenAIIntegration",
);

const createIntegrationName = (id: string) =>
  createPhysicalName({ id, maxLength: 50 });

const getIntegration = (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
  integrationName: string,
) =>
  orUndefinedIfNotFound(
    elastic.GetOpenAI({
      subscriptionId,
      resourceGroupName,
      monitorName,
      integrationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  monitor: string,
  name: string,
  observed: elastic.GetOpenAIResponse,
): OpenAIIntegration["Attributes"] => ({
  monitor,
  resourceGroup,
  integrationName: name,
  integrationId: observed.id ?? "",
  openAIResourceId: observed.properties?.openAIResourceId,
  openAIResourceEndpoint: observed.properties?.openAIResourceEndpoint,
  openAIConnectorId: observed.properties?.openAIConnectorId,
  lastRefreshAt: observed.properties?.lastRefreshAt,
});

export const OpenAIIntegrationProvider = () =>
  Provider.succeed(OpenAIIntegration, {
    stables: ["monitor", "resourceGroup", "integrationName", "integrationId"],

    // Integrations live and die with their monitor, which `list` covers.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.monitor, output.monitor) ||
        (news.name !== undefined &&
          !sameName(news.name, output.integrationName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const monitor = output?.monitor ?? olds?.monitor;
      if (resourceGroup === undefined || monitor === undefined) {
        return undefined;
      }
      const name =
        output?.integrationName ??
        olds?.name ??
        (yield* createIntegrationName(id));
      const observed = yield* getIntegration(
        subscriptionId,
        resourceGroup,
        monitor,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, monitor, name, observed);
      return (yield* isMonitorOwnedByStack(
        subscriptionId,
        resourceGroup,
        monitor,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Elastic");
      const { resourceGroup, monitor } = news;
      const name =
        news.name ??
        output?.integrationName ??
        (yield* createIntegrationName(id));

      // Observe.
      let observed = yield* getIntegration(
        subscriptionId,
        resourceGroup,
        monitor,
        name,
      );

      // Ensure + sync: the key is write-only, so a changed key (against the
      // previous props) also needs a PUT.
      const keyChanged =
        olds?.key === undefined ||
        Redacted.value(olds.key) !== Redacted.value(news.key);
      if (
        observed === undefined ||
        keyChanged ||
        observed.properties?.openAIResourceId?.toLowerCase() !==
          news.openAIResourceId.toLowerCase() ||
        observed.properties?.openAIResourceEndpoint !==
          news.openAIResourceEndpoint
      ) {
        observed = yield* elastic.OpenAICreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          monitorName: monitor,
          integrationName: name,
          properties: {
            openAIResourceId: news.openAIResourceId,
            openAIResourceEndpoint: news.openAIResourceEndpoint,
            key: Redacted.value(news.key),
          },
        });
      }

      return toAttrs(resourceGroup, monitor, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        elastic.DeleteOpenAI({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          monitorName: output.monitor,
          integrationName: output.integrationName,
        }),
      );
      yield* waitUntilGone(
        `Elastic OpenAI integration ${output.integrationName}`,
        getIntegration(
          subscriptionId,
          output.resourceGroup,
          output.monitor,
          output.integrationName,
        ),
        { interval: "5 seconds", times: 24 },
      );
    }),

    nuke: { dependsOn: ["Azure.Elastic.Monitor"] },
  });
