import * as datafactory from "@distilled.cloud/azure/datafactory";
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
  annotationsWithOwnership,
  createChildName,
  definitionDiffers,
  hasOwnershipAnnotation,
  ownershipAnnotation,
  userAnnotations,
} from "./FactoryChild.ts";

/** A Data Factory parameter declaration. */
export interface ParameterSpecification {
  /** Parameter type. */
  type:
    | "Object"
    | "String"
    | "Int"
    | "Float"
    | "Bool"
    | "Array"
    | "SecureString";
  /** Default value of the parameter. */
  defaultValue?: unknown;
}

/** Reference to an integration runtime by name. */
export interface IntegrationRuntimeReference {
  /** Integration runtime name. */
  referenceName: string;
  /** Arguments for the integration runtime's parameters. */
  parameters?: Record<string, unknown>;
}

export interface LinkedServiceProps {
  /** Resource group of the factory. Changing it replaces the linked service. */
  resourceGroup: string;
  /** Name of the factory that holds the linked service. Changing it replaces the linked service. */
  factoryName: string;
  /**
   * Linked service name: up to 260 characters, starting with a letter,
   * digit, or `_`, without `< > * # . % & : \ + ? /`. If omitted, a unique
   * name of letters, digits, and `_` is generated from the app, stage, and
   * logical ID. Changing it replaces the linked service.
   */
  name?: string;
  /**
   * Linked service type, e.g. `AzureBlobStorage`, `AzureSqlDatabase`,
   * `AzureKeyVault`, `RestService`. Changing it replaces the linked service.
   */
  type: string;
  /**
   * Type-specific properties (connection endpoint, authentication, …) as
   * documented for the connector. Prefer managed identity or Key Vault
   * secret references over inline secrets: inline values are stored in
   * Alchemy state.
   */
  typeProperties?: Record<string, unknown>;
  /** Integration runtime to connect through. Defaults to the Azure IR. */
  connectVia?: IntegrationRuntimeReference;
  /** Connector version, e.g. `"2.0"` for connectors with versioned implementations. */
  version?: string;
  /** Linked service description. */
  description?: string;
  /** Parameters the linked service accepts. */
  parameters?: Record<string, ParameterSpecification>;
  /**
   * Annotations shown in the authoring UI. Alchemy appends an ownership
   * annotation (`alchemy:<stack>/<stage>/<id>`).
   */
  annotations?: string[];
}

export interface LinkedService extends Resource<
  "Azure.DataFactory.LinkedService",
  LinkedServiceProps,
  {
    /** Name of the linked service. */
    linkedServiceName: string;
    /** Name of the factory that holds the linked service. */
    factoryName: string;
    /** Resource group of the factory. */
    resourceGroup: string;
    /** ARM resource ID of the linked service. */
    linkedServiceId: string;
    /** Linked service type. */
    type: string;
    /** Entity tag of the current definition. */
    etag: string | undefined;
    /** User annotations (Alchemy ownership annotation stripped). */
    annotations: unknown[];
  },
  never,
  Providers
> {}

/**
 * A Data Factory linked service — the connection information Data Factory
 * uses to reach a data store or compute service. Datasets and activities
 * reference it by name.
 *
 * @see https://learn.microsoft.com/azure/data-factory/concepts-linked-services
 *
 * ### Connecting to Storage
 * **Example:** Blob storage through the factory's managed identity
 * ```typescript
 * const factory = yield* Azure.DataFactory.Factory("etl", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 * });
 * const blob = yield* Azure.DataFactory.LinkedService("blob", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   type: "AzureBlobStorage",
 *   typeProperties: {
 *     serviceEndpoint: "https://myaccount.blob.core.windows.net/",
 *     accountKind: "StorageV2",
 *   },
 * });
 * ```
 *
 * ### Connecting to HTTP APIs
 * **Example:** Anonymous REST service
 * ```typescript
 * const api = yield* Azure.DataFactory.LinkedService("api", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   type: "RestService",
 *   typeProperties: {
 *     url: "https://api.example.com",
 *     authenticationType: "Anonymous",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const LinkedService = Resource<LinkedService>(
  "Azure.DataFactory.LinkedService",
);

const getLinkedService = (
  subscriptionId: string,
  resourceGroupName: string,
  factoryName: string,
  linkedServiceName: string,
) =>
  orUndefinedIfNotFound(
    datafactory.GetLinkedService({
      subscriptionId,
      resourceGroupName,
      factoryName,
      linkedServiceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  factoryName: string,
  name: string,
  observed: datafactory.GetLinkedServiceResponse,
): LinkedService["Attributes"] => ({
  linkedServiceName: name,
  factoryName,
  resourceGroup,
  linkedServiceId: observed.id ?? "",
  type: observed.properties.type,
  etag: observed.etag,
  annotations: userAnnotations(observed.properties.annotations),
});

export const LinkedServiceProvider = () =>
  Provider.succeed(LinkedService, {
    stables: [
      "linkedServiceName",
      "factoryName",
      "resourceGroup",
      "linkedServiceId",
      "type",
    ],

    // Linked services live inside a factory; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.factoryName.toLowerCase() !== output.factoryName.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.linkedServiceName.toLowerCase()) ||
        news.type !== output.type
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const factoryName = output?.factoryName ?? olds?.factoryName;
      if (resourceGroup === undefined || factoryName === undefined) {
        return undefined;
      }
      const name =
        output?.linkedServiceName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getLinkedService(
        subscriptionId,
        resourceGroup,
        factoryName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, factoryName, name, observed);
      const marker = yield* ownershipAnnotation(id);
      return hasOwnershipAnnotation(marker, observed.properties.annotations)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataFactory");
      const { resourceGroup, factoryName } = news;
      const name =
        news.name ?? output?.linkedServiceName ?? (yield* createChildName(id));
      const marker = yield* ownershipAnnotation(id);
      const desired = {
        type: news.type,
        typeProperties: news.typeProperties,
        connectVia: news.connectVia
          ? { type: "IntegrationRuntimeReference", ...news.connectVia }
          : undefined,
        version: news.version,
        description: news.description,
        parameters: news.parameters,
        annotations: annotationsWithOwnership(news.annotations, marker),
      };

      // Observe.
      let observed = yield* getLinkedService(
        subscriptionId,
        resourceGroup,
        factoryName,
        name,
      );

      // Ensure + sync: the PUT is a synchronous full-definition upsert, so
      // one PUT covers both and is skipped when nothing changed.
      if (
        observed === undefined ||
        definitionDiffers(desired, observed.properties)
      ) {
        observed = yield* datafactory.LinkedServicesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          factoryName,
          linkedServiceName: name,
          properties: desired,
        });
      }

      return toAttrs(resourceGroup, factoryName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datafactory.DeleteLinkedService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          factoryName: output.factoryName,
          linkedServiceName: output.linkedServiceName,
        }),
      );
      yield* waitUntilGone(
        `linked service ${output.linkedServiceName}`,
        getLinkedService(
          subscriptionId,
          output.resourceGroup,
          output.factoryName,
          output.linkedServiceName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.DataFactory.Factory"] },
  });
