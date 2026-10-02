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

/** A dependency of an activity on the outcome of another activity. */
export interface ActivityDependency {
  /** Name of the activity depended on. */
  activity: string;
  /** Outcomes that satisfy the dependency, e.g. `["Succeeded"]`. */
  dependencyConditions: Array<"Succeeded" | "Failed" | "Skipped" | "Completed">;
}

/** A pipeline activity. */
export interface PipelineActivity {
  /** Activity name, unique within the pipeline. */
  name: string;
  /** Activity type, e.g. `Wait`, `Copy`, `ExecuteDataFlow`, `WebActivity`. */
  type: string;
  /** Activity description. */
  description?: string;
  /** Whether the activity runs. @default "Active" */
  state?: "Active" | "Inactive";
  /** Status reported for an inactive activity. @default "Succeeded" */
  onInactiveMarkAs?: "Succeeded" | "Failed" | "Skipped";
  /** Activities that must finish first. */
  dependsOn?: ActivityDependency[];
  /** User properties shown in monitoring. */
  userProperties?: Array<{ name: string; value: unknown }>;
  /** Type-specific activity properties as documented for the activity type. */
  typeProperties?: Record<string, unknown>;
  /**
   * Linked service the activity runs on (execution activities), e.g.
   * `{ referenceName: "my_ls", type: "LinkedServiceReference" }`.
   */
  linkedServiceName?: Record<string, unknown>;
  /** Execution policy (timeout, retries) of execution activities. */
  policy?: Record<string, unknown>;
  /** Input dataset references (data movement activities). */
  inputs?: Array<Record<string, unknown>>;
  /** Output dataset references (data movement activities). */
  outputs?: Array<Record<string, unknown>>;
}

/** A pipeline variable declaration. */
export interface VariableSpecification {
  /** Variable type. */
  type: "String" | "Bool" | "Array";
  /** Default value of the variable. */
  defaultValue?: unknown;
}

export interface PipelineProps {
  /** Resource group of the factory. Changing it replaces the pipeline. */
  resourceGroup: string;
  /** Name of the factory that holds the pipeline. Changing it replaces the pipeline. */
  factoryName: string;
  /**
   * Pipeline name: up to 260 characters, starting with a letter, digit, or
   * `_`, without `< > * # . % & : \ + ? /`. If omitted, a unique name of
   * letters, digits, and `_` is generated from the app, stage, and logical
   * ID. Changing it replaces the pipeline.
   */
  name?: string;
  /** Activities that make up the pipeline. */
  activities?: PipelineActivity[];
  /** Parameters the pipeline accepts. */
  parameters?: Record<string, ParameterSpecification>;
  /** Variables the pipeline declares. */
  variables?: Record<string, VariableSpecification>;
  /** Maximum number of concurrent runs. */
  concurrency?: number;
  /** Dimensions emitted by the pipeline for metrics. */
  runDimensions?: Record<string, unknown>;
  /** Folder shown in the authoring UI. */
  folder?: string;
  /**
   * Elapsed-time metric threshold, e.g. `"0.00:10:00"`; runs longer than
   * this raise the `Elapsed Time Pipeline Run` metric.
   */
  elapsedTimeMetricDuration?: string;
  /** Pipeline description. */
  description?: string;
  /**
   * Annotations shown in the authoring UI. Alchemy appends an ownership
   * annotation (`alchemy:<stack>/<stage>/<id>`).
   */
  annotations?: string[];
}

export interface Pipeline extends Resource<
  "Azure.DataFactory.Pipeline",
  PipelineProps,
  {
    /** Name of the pipeline. */
    pipelineName: string;
    /** Name of the factory that holds the pipeline. */
    factoryName: string;
    /** Resource group of the factory. */
    resourceGroup: string;
    /** ARM resource ID of the pipeline. */
    pipelineId: string;
    /** Entity tag of the current definition. */
    etag: string | undefined;
    /** User annotations (Alchemy ownership annotation stripped). */
    annotations: unknown[];
  },
  never,
  Providers
> {}

/**
 * A Data Factory pipeline — a logical grouping of activities that
 * together perform a task. Runs are started on demand or by a trigger.
 *
 * @see https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities
 *
 * ### Defining Pipelines
 * **Example:** Pipeline with a Wait activity
 * ```typescript
 * const pipeline = yield* Azure.DataFactory.Pipeline("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   activities: [
 *     { name: "pause", type: "Wait", typeProperties: { waitTimeInSeconds: 5 } },
 *   ],
 * });
 * ```
 *
 * **Example:** Copy activity between two datasets
 * ```typescript
 * const copy = yield* Azure.DataFactory.Pipeline("copy", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   parameters: { date: { type: "String" } },
 *   activities: [
 *     {
 *       name: "copy",
 *       type: "Copy",
 *       inputs: [{ referenceName: source.datasetName, type: "DatasetReference" }],
 *       outputs: [{ referenceName: sink.datasetName, type: "DatasetReference" }],
 *       typeProperties: {
 *         source: { type: "DelimitedTextSource" },
 *         sink: { type: "DelimitedTextSink" },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Pipeline = Resource<Pipeline>("Azure.DataFactory.Pipeline");

const getPipeline = (
  subscriptionId: string,
  resourceGroupName: string,
  factoryName: string,
  pipelineName: string,
) =>
  orUndefinedIfNotFound(
    datafactory.GetPipeline({
      subscriptionId,
      resourceGroupName,
      factoryName,
      pipelineName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  factoryName: string,
  name: string,
  observed: datafactory.GetPipelineResponse,
): Pipeline["Attributes"] => ({
  pipelineName: name,
  factoryName,
  resourceGroup,
  pipelineId: observed.id ?? "",
  etag: observed.etag,
  annotations: userAnnotations(observed.properties.annotations),
});

export const PipelineProvider = () =>
  Provider.succeed(Pipeline, {
    stables: ["pipelineName", "factoryName", "resourceGroup", "pipelineId"],

    // Pipelines live inside a factory; nuke removes them with it.
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
          news.name.toLowerCase() !== output.pipelineName.toLowerCase())
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
        output?.pipelineName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getPipeline(
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
        news.name ?? output?.pipelineName ?? (yield* createChildName(id));
      const marker = yield* ownershipAnnotation(id);
      const desired = {
        activities: news.activities,
        parameters: news.parameters,
        variables: news.variables,
        concurrency: news.concurrency,
        runDimensions: news.runDimensions,
        folder: news.folder ? { name: news.folder } : undefined,
        policy: news.elapsedTimeMetricDuration
          ? { elapsedTimeMetric: { duration: news.elapsedTimeMetricDuration } }
          : undefined,
        description: news.description,
        annotations: annotationsWithOwnership(news.annotations, marker),
      };

      // Observe.
      let observed = yield* getPipeline(
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
        observed = yield* datafactory.PipelinesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          factoryName,
          pipelineName: name,
          properties: desired,
        });
      }

      return toAttrs(resourceGroup, factoryName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datafactory.DeletePipeline({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          factoryName: output.factoryName,
          pipelineName: output.pipelineName,
        }),
      );
      yield* waitUntilGone(
        `pipeline ${output.pipelineName}`,
        getPipeline(
          subscriptionId,
          output.resourceGroup,
          output.factoryName,
          output.pipelineName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.DataFactory.Factory"] },
  });
