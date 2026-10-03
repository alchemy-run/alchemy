import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  orUndefinedIfNotFound,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { checkResourceGroup, jobOwnedByStage, lower } from "./Common.ts";

export interface TransformationProps {
  /**
   * Resource group of the streaming job. Changing it replaces the
   * transformation.
   */
  resourceGroup: string;
  /** Name of the streaming job. Changing it replaces the transformation. */
  streamingJob: string;
  /**
   * Transformation name. A job has exactly one transformation. Changing it
   * replaces the transformation.
   * @default "Transformation"
   */
  name?: string;
  /**
   * Stream Analytics query (SAQL), e.g.
   * `SELECT * INTO [archive] FROM [events]`.
   */
  query: string;
  /**
   * Streaming units the job runs with (`1`, `3`, `6`, then multiples of 6
   * for Standard jobs). Billed per unit-hour only while the job runs.
   * @default 1
   */
  streamingUnits?: number;
}

export interface Transformation extends Resource<
  "Azure.StreamAnalytics.Transformation",
  TransformationProps,
  {
    /** Name of the transformation. */
    transformationName: string;
    /** Name of the streaming job. */
    streamingJob: string;
    /** Resource group of the streaming job. */
    resourceGroup: string;
    /** ARM resource ID of the transformation. */
    transformationId: string;
    /** Current query. */
    query: string | undefined;
    /** Streaming units the job runs with. */
    streamingUnits: number | undefined;
    /** Streaming-unit values the job can be scaled to while running. */
    validStreamingUnits: number[] | undefined;
    /** Entity tag of the current transformation. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The query of an Azure Stream Analytics streaming job, together with the
 * number of streaming units it runs on.
 *
 * A job has exactly one transformation, and Azure has no API to delete it
 * on its own: destroying this resource leaves the query in place until its
 * streaming job is deleted. It carries no tags; Alchemy treats it as owned
 * when its streaming job carries this stack's and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/stream-analytics/stream-analytics-stream-analytics-query-patterns
 *
 * ### Defining the Query
 * **Example:** Pass-through query
 * ```typescript
 * const query = yield* Azure.StreamAnalytics.Transformation("query", {
 *   resourceGroup: group.resourceGroupName,
 *   streamingJob: job.jobName,
 *   query: `SELECT * INTO [${archive.outputName}] FROM [${events.inputName}]`,
 * });
 * ```
 *
 * **Example:** Windowed aggregate on 3 streaming units
 * ```typescript
 * const query = yield* Azure.StreamAnalytics.Transformation("query", {
 *   resourceGroup: group.resourceGroupName,
 *   streamingJob: job.jobName,
 *   streamingUnits: 3,
 *   query: `
 *     SELECT deviceId, AVG(temperature) AS avgTemperature
 *     INTO [archive]
 *     FROM [events] TIMESTAMP BY eventTime
 *     GROUP BY deviceId, TumblingWindow(minute, 5)`,
 * });
 * ```
 *
 * @resource
 */
export const Transformation = Resource<Transformation>(
  "Azure.StreamAnalytics.Transformation",
);

const DEFAULT_NAME = "Transformation";

const getTransformation = (
  subscriptionId: string,
  resourceGroupName: string,
  jobName: string,
  transformationName: string,
) =>
  orUndefinedIfNotFound(
    streamanalytics.GetTransformation({
      subscriptionId,
      resourceGroupName,
      jobName,
      transformationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  streamingJob: string,
  name: string,
  transformation: streamanalytics.GetTransformationResponse,
): Transformation["Attributes"] => ({
  transformationName: name,
  streamingJob,
  resourceGroup,
  transformationId: transformation.id ?? "",
  query: transformation.properties?.query,
  streamingUnits: transformation.properties?.streamingUnits,
  validStreamingUnits: transformation.properties?.validStreamingUnits,
  etag: transformation.properties?.etag,
});

export const TransformationProvider = () =>
  Provider.succeed(Transformation, {
    stables: [
      "transformationName",
      "streamingJob",
      "resourceGroup",
      "transformationId",
    ],

    // Transformations live inside a streaming job; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.streamingJob) !== lower(output.streamingJob) ||
        lower(news.name ?? DEFAULT_NAME) !== lower(output.transformationName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const streamingJob = output?.streamingJob ?? olds?.streamingJob;
      if (resourceGroup === undefined || streamingJob === undefined) {
        return undefined;
      }
      const name = output?.transformationName ?? olds?.name ?? DEFAULT_NAME;
      const observed = yield* getTransformation(
        subscriptionId,
        resourceGroup,
        streamingJob,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, streamingJob, name, observed);
      return (yield* jobOwnedByStage(
        subscriptionId,
        resourceGroup,
        streamingJob,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StreamAnalytics");
      const { resourceGroup, streamingJob } = news;
      yield* checkResourceGroup(resourceGroup);
      const name = news.name ?? DEFAULT_NAME;
      const streamingUnits = news.streamingUnits ?? 1;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        jobName: streamingJob,
        transformationName: name,
      };
      const get = getTransformation(
        subscriptionId,
        resourceGroup,
        streamingJob,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure, then sync the query and streaming units against the
      // observed transformation; PATCH only what changed.
      if (observed === undefined) {
        yield* streamanalytics.TransformationsCreateOrReplace({
          ...where,
          properties: { query: news.query, streamingUnits },
        });
      } else {
        const queryChanged = observed.properties?.query !== news.query;
        const unitsChanged =
          observed.properties?.streamingUnits !== streamingUnits;
        if (queryChanged || unitsChanged) {
          yield* streamanalytics.UpdateTransformation({
            ...where,
            properties: {
              query: queryChanged ? news.query : undefined,
              streamingUnits: unitsChanged ? streamingUnits : undefined,
            },
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `stream analytics transformation ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, streamingJob, name, fresh);
    }),

    // Azure has no delete operation for a transformation; it is removed
    // together with its streaming job.
    delete: Effect.fn(function* () {
      yield* Effect.void;
    }),
  });
