import * as datafactory from "@distilled.cloud/azure/datafactory";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  annotationsWithOwnership,
  createChildName,
  definitionDiffers,
  hasOwnershipAnnotation,
  ownershipAnnotation,
  userAnnotations,
} from "./FactoryChild.ts";

export type DataFlowType = "MappingDataFlow" | "Flowlet" | "WranglingDataFlow";

export interface DataFlowProps {
  /**
   * Resource group of the factory. Changing it replaces the data flow.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the factory that holds the data flow. Changing it replaces the data flow. */
  factoryName: string;
  /**
   * Data flow name: letters, digits, and `_`, up to 260 characters. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the data flow.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Data flow type. Changing it replaces the data flow.
   * @default "MappingDataFlow"
   */
  type?: DataFlowType;
  /**
   * Type-specific properties: `sources`, `sinks`, `transformations`, and
   * the data flow `script` or `scriptLines`.
   * @default {}
   */
  typeProperties?: Record<string, unknown>;
  /**
   * Folder shown in the authoring UI.
   * @default none (the root folder)
   */
  folder?: string;
  /**
   * Data flow description.
   * @default none
   */
  description?: string;
  /**
   * Annotations shown in the authoring UI. Alchemy appends an ownership
   * annotation (`alchemy:<stack>/<stage>/<id>`).
   * @default []
   */
  annotations?: string[];
}

export interface DataFlow extends Resource<
  "Azure.DataFactory.DataFlow",
  DataFlowProps,
  {
    /** Name of the data flow. */
    dataFlowName: string;
    /** Name of the factory that holds the data flow. */
    factoryName: string;
    /** Resource group of the factory. */
    resourceGroup: string;
    /** ARM resource ID of the data flow. */
    dataFlowId: string;
    /** Data flow type. */
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
 * A Data Factory data flow (`Microsoft.DataFactory/factories/dataflows`) —
 * a visually designed Spark transformation (mapping data flow), a reusable
 * flowlet, or a Power Query wrangling flow. Defining a data flow is free;
 * executing it from a pipeline bills Spark vCore-hours.
 *
 * :::caution
 * Changing `resourceGroup`, `factoryName`, `name`, or `type` replaces the
 * data flow.
 * :::
 *
 * See [Mapping data flows](https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview).
 *
 * ### Defining Data Flows
 * **Example:** Copy rows from one dataset to another
 * ```typescript
 * const factory = yield* Azure.DataFactory.Factory("etl", {
 *   identity: { type: "SystemAssigned" },
 * });
 * const account = yield* Azure.Storage.StorageAccount("lake");
 * const blob = yield* Azure.DataFactory.LinkedService("blob", {
 *   factoryName: factory.factoryName,
 *   type: "AzureBlobStorage",
 *   typeProperties: { serviceEndpoint: account.primaryEndpoints.blob },
 * });
 * const raw = yield* Azure.DataFactory.Dataset("raw", {
 *   factoryName: factory.factoryName,
 *   type: "Json",
 *   linkedServiceName: { referenceName: blob.linkedServiceName },
 *   typeProperties: {
 *     location: { type: "AzureBlobStorageLocation", container: "raw" },
 *   },
 * });
 * const curated = yield* Azure.DataFactory.Dataset("curated", {
 *   factoryName: factory.factoryName,
 *   type: "Json",
 *   linkedServiceName: { referenceName: blob.linkedServiceName },
 *   typeProperties: {
 *     location: { type: "AzureBlobStorageLocation", container: "curated" },
 *   },
 * });
 * const flow = yield* Azure.DataFactory.DataFlow("orders", {
 *   factoryName: factory.factoryName,
 *   typeProperties: {
 *     sources: [
 *       { name: "input", dataset: { referenceName: raw.datasetName, type: "DatasetReference" } },
 *     ],
 *     sinks: [
 *       { name: "output", dataset: { referenceName: curated.datasetName, type: "DatasetReference" } },
 *     ],
 *     scriptLines: [
 *       "source(allowSchemaDrift: true, validateSchema: false) ~> input",
 *       "input sink(allowSchemaDrift: true, validateSchema: false) ~> output",
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DataFlow = GroupedResource<DataFlow>("Azure.DataFactory.DataFlow");

const getDataFlow = (
  subscriptionId: string,
  resourceGroupName: string,
  factoryName: string,
  dataFlowName: string,
) =>
  orUndefinedIfNotFound(
    datafactory.GetDataFlow({
      subscriptionId,
      resourceGroupName,
      factoryName,
      dataFlowName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  factoryName: string,
  name: string,
  observed: datafactory.GetDataFlowResponse,
): DataFlow["Attributes"] => ({
  dataFlowName: name,
  factoryName,
  resourceGroup,
  dataFlowId: observed.id ?? "",
  type: observed.properties.type,
  etag: observed.etag,
  annotations: userAnnotations(observed.properties.annotations),
});

export const DataFlowProvider = () =>
  Provider.succeed(DataFlow, {
    stables: ["dataFlowName", "factoryName", "resourceGroup", "dataFlowId", "type"],

    // Data flows live inside a factory; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.factoryName.toLowerCase() !== output.factoryName.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.dataFlowName.toLowerCase()) ||
        (news.type ?? "MappingDataFlow") !== output.type
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
      const name = output?.dataFlowName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getDataFlow(subscriptionId, resourceGroup, factoryName, name);
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
      const name = news.name ?? output?.dataFlowName ?? (yield* createChildName(id));
      const marker = yield* ownershipAnnotation(id);
      const desired = {
        type: news.type ?? "MappingDataFlow",
        typeProperties: news.typeProperties,
        folder: news.folder ? { name: news.folder } : undefined,
        description: news.description,
        annotations: annotationsWithOwnership(news.annotations, marker),
      };

      // Observe.
      let observed = yield* getDataFlow(subscriptionId, resourceGroup, factoryName, name);

      // Ensure + sync with one synchronous full-definition PUT, skipped
      // when the observed definition already matches.
      if (observed === undefined || definitionDiffers(desired, observed.properties)) {
        observed = yield* datafactory.DataFlowsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          factoryName,
          dataFlowName: name,
          properties: desired,
        });
      }

      return toAttrs(resourceGroup, factoryName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datafactory.DeleteDataFlow({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          factoryName: output.factoryName,
          dataFlowName: output.dataFlowName,
        }),
      );
      yield* waitUntilGone(
        `data flow ${output.dataFlowName}`,
        getDataFlow(subscriptionId, output.resourceGroup, output.factoryName, output.dataFlowName),
      );
    }),

    nuke: {
      dependsOn: ["Azure.DataFactory.Dataset", "Azure.DataFactory.Factory"],
    },
  });
