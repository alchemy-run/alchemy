import * as edge from "@distilled.cloud/azure/edge";
import * as Effect from "effect/Effect";
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
import { EDGE_WAIT, edgeState, sameId } from "./EdgeShared.ts";

export interface ConfigurationReferenceProps {
  /**
   * ARM resource ID of the hierarchy entity (an `Azure.Edge.Site` or
   * target) the reference is attached to. Changing it replaces the
   * reference.
   */
  resourceUri: string;
  /**
   * Name of the reference. Azure expects `default`. Changing it replaces
   * the reference.
   * @default "default"
   */
  name?: string;
  /** ARM resource ID of the `Azure.Edge.Configuration` to link. */
  configurationResourceId: string;
}

export interface ConfigurationReference extends Resource<
  "Azure.Edge.ConfigurationReference",
  ConfigurationReferenceProps,
  {
    /** Name of the reference. */
    configurationReferenceName: string;
    /** ARM resource ID of the entity the reference is attached to. */
    resourceUri: string;
    /** ARM resource ID of the reference. */
    configurationReferenceId: string;
    /** ARM resource ID of the linked configuration. */
    configurationResourceId: string;
  },
  never,
  Providers
> {}

/**
 * Links an Azure Arc workload orchestration configuration to a hierarchy
 * entity (a site or a target). It is an extension resource that lives
 * under the entity's ARM ID.
 *
 * References carry no tags or free-form fields, so Alchemy cannot mark
 * them; one found at the expected scope is treated as this resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuration-model
 *
 * ### Linking a Configuration
 * **Example:** Configuration for a site
 * ```typescript
 * yield* Azure.Edge.ConfigurationReference("plant-config-ref", {
 *   resourceUri: site.siteId,
 *   configurationResourceId: configuration.configurationId,
 * });
 * ```
 *
 * @resource
 */
export const ConfigurationReference = Resource<ConfigurationReference>(
  "Azure.Edge.ConfigurationReference",
);

const getReference = (
  resourceUri: string,
  configurationReferenceName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetConfigurationReference({ resourceUri, configurationReferenceName }),
  );

const toAttrs = (
  resourceUri: string,
  name: string,
  observed: edge.GetConfigurationReferenceResponse,
): ConfigurationReference["Attributes"] => ({
  configurationReferenceName: name,
  resourceUri,
  configurationReferenceId: observed.id ?? "",
  configurationResourceId: observed.properties?.configurationResourceId ?? "",
});

export const ConfigurationReferenceProvider = () =>
  Provider.succeed(ConfigurationReference, {
    stables: [
      "configurationReferenceName",
      "resourceUri",
      "configurationReferenceId",
    ],

    // Extension resources vanish with the entity they extend.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceUri, output.resourceUri) ||
        (news.name ?? "default").toLowerCase() !==
          output.configurationReferenceName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const resourceUri = output?.resourceUri ?? olds?.resourceUri;
      if (resourceUri === undefined) return undefined;
      const name =
        output?.configurationReferenceName ?? olds?.name ?? "default";
      const observed = yield* getReference(resourceUri, name);
      return observed === undefined
        ? undefined
        : toAttrs(resourceUri, name, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const { resourceUri } = news;
      const name = news.name ?? "default";
      const get = getReference(resourceUri, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync the linked configuration against observed state.
      if (observed === undefined) {
        yield* edge.ConfigurationReferencesCreateOrUpdate({
          resourceUri,
          configurationReferenceName: name,
          properties: { configurationResourceId: news.configurationResourceId },
        });
      } else if (
        !sameId(
          observed.properties?.configurationResourceId,
          news.configurationResourceId,
        )
      ) {
        yield* edge.UpdateConfigurationReference({
          resourceUri,
          configurationReferenceName: name,
          properties: { configurationResourceId: news.configurationResourceId },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge configuration reference ${resourceUri}/${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceUri, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        edge.DeleteConfigurationReference({
          resourceUri: output.resourceUri,
          configurationReferenceName: output.configurationReferenceName,
        }),
      );
      yield* waitUntilGone(
        `edge configuration reference ${output.resourceUri}/${output.configurationReferenceName}`,
        getReference(output.resourceUri, output.configurationReferenceName),
        EDGE_WAIT,
      );
    }),
  });
