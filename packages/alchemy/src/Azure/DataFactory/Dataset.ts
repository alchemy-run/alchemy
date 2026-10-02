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
import type { ParameterSpecification } from "./LinkedService.ts";

/** Reference to a linked service by name. */
export interface LinkedServiceReference {
  /** Linked service name. */
  referenceName: string;
  /** Arguments for the linked service's parameters. */
  parameters?: Record<string, unknown>;
}

export interface DatasetProps {
  /** Resource group of the factory. Changing it replaces the dataset. */
  resourceGroup: string;
  /** Name of the factory that holds the dataset. Changing it replaces the dataset. */
  factoryName: string;
  /**
   * Dataset name: up to 260 characters, starting with a letter, digit, or
   * `_`, without `< > * # . % & : \ + ? /`. If omitted, a unique name of
   * letters, digits, and `_` is generated from the app, stage, and logical
   * ID. Changing it replaces the dataset.
   */
  name?: string;
  /**
   * Dataset type, e.g. `DelimitedText`, `Json`, `Parquet`,
   * `AzureSqlTable`. Changing it replaces the dataset.
   */
  type: string;
  /** Linked service that holds the data. */
  linkedServiceName: LinkedServiceReference;
  /**
   * Type-specific properties (location, format settings, table name, …)
   * as documented for the dataset type.
   */
  typeProperties?: Record<string, unknown>;
  /** Columns that define the structure of the dataset. */
  structure?: unknown;
  /** Columns that define the physical schema of the dataset. */
  schema?: unknown;
  /** Parameters the dataset accepts. */
  parameters?: Record<string, ParameterSpecification>;
  /** Folder shown in the authoring UI. */
  folder?: string;
  /** Dataset description. */
  description?: string;
  /**
   * Annotations shown in the authoring UI. Alchemy appends an ownership
   * annotation (`alchemy:<stack>/<stage>/<id>`).
   */
  annotations?: string[];
}

export interface Dataset extends Resource<
  "Azure.DataFactory.Dataset",
  DatasetProps,
  {
    /** Name of the dataset. */
    datasetName: string;
    /** Name of the factory that holds the dataset. */
    factoryName: string;
    /** Resource group of the factory. */
    resourceGroup: string;
    /** ARM resource ID of the dataset. */
    datasetId: string;
    /** Dataset type. */
    type: string;
    /** Folder shown in the authoring UI. */
    folder: string | undefined;
    /** Entity tag of the current definition. */
    etag: string | undefined;
    /** User annotations (Alchemy ownership annotation stripped). */
    annotations: unknown[];
  },
  never,
  Providers
> {}

/**
 * A Data Factory dataset — a named view of data in a linked service
 * (a file, folder, table, or API resource) used as an activity or data
 * flow input or output.
 *
 * @see https://learn.microsoft.com/azure/data-factory/concepts-datasets-linked-services
 *
 * ### Defining Datasets
 * **Example:** CSV files in a blob container
 * ```typescript
 * const csv = yield* Azure.DataFactory.Dataset("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   type: "DelimitedText",
 *   linkedServiceName: { referenceName: blob.linkedServiceName },
 *   typeProperties: {
 *     location: {
 *       type: "AzureBlobStorageLocation",
 *       container: "raw",
 *       folderPath: "orders",
 *     },
 *     columnDelimiter: ",",
 *     firstRowAsHeader: true,
 *   },
 *   folder: "raw",
 * });
 * ```
 *
 * @resource
 */
export const Dataset = Resource<Dataset>("Azure.DataFactory.Dataset");

const getDataset = (
  subscriptionId: string,
  resourceGroupName: string,
  factoryName: string,
  datasetName: string,
) =>
  orUndefinedIfNotFound(
    datafactory.GetDataset({
      subscriptionId,
      resourceGroupName,
      factoryName,
      datasetName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  factoryName: string,
  name: string,
  observed: datafactory.GetDatasetResponse,
): Dataset["Attributes"] => ({
  datasetName: name,
  factoryName,
  resourceGroup,
  datasetId: observed.id ?? "",
  type: observed.properties.type,
  folder: observed.properties.folder?.name,
  etag: observed.etag,
  annotations: userAnnotations(observed.properties.annotations),
});

export const DatasetProvider = () =>
  Provider.succeed(Dataset, {
    stables: [
      "datasetName",
      "factoryName",
      "resourceGroup",
      "datasetId",
      "type",
    ],

    // Datasets live inside a factory; nuke removes them with it.
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
          news.name.toLowerCase() !== output.datasetName.toLowerCase()) ||
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
        output?.datasetName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getDataset(
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
        news.name ?? output?.datasetName ?? (yield* createChildName(id));
      const marker = yield* ownershipAnnotation(id);
      const desired = {
        type: news.type,
        linkedServiceName: {
          type: "LinkedServiceReference",
          ...news.linkedServiceName,
        },
        typeProperties: news.typeProperties,
        structure: news.structure,
        schema: news.schema,
        parameters: news.parameters,
        folder: news.folder ? { name: news.folder } : undefined,
        description: news.description,
        annotations: annotationsWithOwnership(news.annotations, marker),
      };

      // Observe.
      let observed = yield* getDataset(
        subscriptionId,
        resourceGroup,
        factoryName,
        name,
      );

      // Ensure + sync with one synchronous full-definition PUT, skipped
      // when the observed definition already matches.
      if (
        observed === undefined ||
        definitionDiffers(desired, observed.properties)
      ) {
        observed = yield* datafactory.DatasetsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          factoryName,
          datasetName: name,
          properties: desired,
        });
      }

      return toAttrs(resourceGroup, factoryName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datafactory.DeleteDataset({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          factoryName: output.factoryName,
          datasetName: output.datasetName,
        }),
      );
      yield* waitUntilGone(
        `dataset ${output.datasetName}`,
        getDataset(
          subscriptionId,
          output.resourceGroup,
          output.factoryName,
          output.datasetName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.DataFactory.LinkedService",
        "Azure.DataFactory.Factory",
      ],
    },
  });
