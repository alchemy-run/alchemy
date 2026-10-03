import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
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
  canonical,
  createStreamAnalyticsName,
  jobOwnedByStage,
  lower,
  matchesObserved,
  type TypedDocument,
  checkResourceGroup,
} from "./Common.ts";

export interface FunctionParameter {
  /**
   * Stream Analytics data type of the parameter, e.g. `any`, `bigint`,
   * `float`, `nvarchar(max)`, `datetime`, `record`, `array`.
   */
  dataType: string;
  /**
   * Whether the parameter is expected to be a constant.
   * @default false
   */
  isConfigurationParameter?: boolean;
}

export interface FunctionProps {
  /** Resource group of the streaming job. Changing it replaces the function. */
  resourceGroup: string;
  /** Name of the streaming job. Changing it replaces the function. */
  streamingJob: string;
  /**
   * Function name, called from the job's query as `udf.<name>(...)`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the function.
   */
  name?: string;
  /**
   * Scalar functions return one value per event; aggregates fold a window.
   * Changing it replaces the function.
   * @default "Scalar"
   */
  type?: "Scalar" | "Aggregate";
  /** Input parameters, in order. */
  inputs?: FunctionParameter[];
  /** Data type of the return value, e.g. `bigint`. */
  output: { dataType: string };
  /**
   * Implementation, e.g. `{ type: "Microsoft.StreamAnalytics/JavascriptUdf",
   * properties: { script: "function (x) { return x * 2; }" } }`, or an Azure
   * Machine Learning endpoint (`Microsoft.MachineLearningServices`). API
   * keys are write-only in Azure; their changes are detected against the
   * previous props.
   */
  binding: TypedDocument;
}

export interface Function extends Resource<
  "Azure.StreamAnalytics.Function",
  FunctionProps,
  {
    /** Name of the function. */
    functionName: string;
    /** Name of the streaming job. */
    streamingJob: string;
    /** Resource group of the streaming job. */
    resourceGroup: string;
    /** ARM resource ID of the function. */
    functionId: string;
    /** Function type (`Scalar` or `Aggregate`). */
    type: string;
    /** Binding type, e.g. `Microsoft.StreamAnalytics/JavascriptUdf`. */
    bindingType: string | undefined;
    /** Entity tag of the current function definition. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A user-defined function of an Azure Stream Analytics streaming job — a
 * JavaScript UDF or UDA, or an Azure Machine Learning endpoint — callable
 * from the job's query as `udf.<name>(...)`.
 *
 * Functions carry no tags; Alchemy treats one as owned when its streaming
 * job carries this stack's and stage's ownership tags. Changes are rejected
 * while the job is running.
 *
 * @see https://learn.microsoft.com/azure/stream-analytics/javascript-user-defined-functions
 *
 * ### JavaScript Functions
 * **Example:** Scalar JavaScript UDF
 * ```typescript
 * const double = yield* Azure.StreamAnalytics.Function("double", {
 *   resourceGroup: group.resourceGroupName,
 *   streamingJob: job.jobName,
 *   name: "double",
 *   inputs: [{ dataType: "bigint" }],
 *   output: { dataType: "bigint" },
 *   binding: {
 *     type: "Microsoft.StreamAnalytics/JavascriptUdf",
 *     properties: { script: "function (x) { return x * 2; }" },
 *   },
 * });
 * const query = yield* Azure.StreamAnalytics.Transformation("query", {
 *   resourceGroup: group.resourceGroupName,
 *   streamingJob: job.jobName,
 *   query: "SELECT udf.double(value) AS doubled INTO [out] FROM [in]",
 * });
 * ```
 *
 * @resource
 */
export const Function = Resource<Function>("Azure.StreamAnalytics.Function");

const getFunction = (
  subscriptionId: string,
  resourceGroupName: string,
  jobName: string,
  functionName: string,
) =>
  orUndefinedIfNotFound(
    streamanalytics.GetFunction({
      subscriptionId,
      resourceGroupName,
      jobName,
      functionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  streamingJob: string,
  name: string,
  fn: streamanalytics.GetFunctionResponse,
): Function["Attributes"] => ({
  functionName: name,
  streamingJob,
  resourceGroup,
  functionId: fn.id ?? "",
  type: fn.properties?.type ?? "Scalar",
  bindingType: fn.properties?.properties?.binding?.type,
  etag: fn.properties?.etag,
});

export const FunctionProvider = () =>
  Provider.succeed(Function, {
    stables: ["functionName", "streamingJob", "resourceGroup", "functionId"],

    // Functions live inside a streaming job; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.streamingJob) !== lower(output.streamingJob) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.functionName)) ||
        lower(news.type ?? "Scalar") !== lower(output.type)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const streamingJob = output?.streamingJob ?? olds?.streamingJob;
      if (resourceGroup === undefined || streamingJob === undefined) {
        return undefined;
      }
      const name =
        output?.functionName ??
        olds?.name ??
        (yield* createStreamAnalyticsName(id));
      const observed = yield* getFunction(
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

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StreamAnalytics");
      const { resourceGroup, streamingJob } = news;
      yield* checkResourceGroup(resourceGroup);
      const name =
        news.name ??
        output?.functionName ??
        (yield* createStreamAnalyticsName(id));
      const properties: streamanalytics.FunctionPropertiesInput = {
        type: news.type ?? "Scalar",
        properties: {
          inputs: news.inputs,
          output: news.output,
          binding: news.binding,
        },
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        jobName: streamingJob,
        functionName: name,
      };
      const get = getFunction(
        subscriptionId,
        resourceGroup,
        streamingJob,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure, then sync: PATCH the full desired definition when the
      // observed one drifted, or when a write-only key in the binding
      // changed since the last deploy.
      if (observed === undefined) {
        yield* streamanalytics.FunctionsCreateOrReplace({
          ...where,
          properties,
        });
      } else if (
        !matchesObserved(properties, observed.properties) ||
        (olds !== undefined &&
          canonical(olds.binding) !== canonical(news.binding))
      ) {
        yield* streamanalytics.UpdateFunction({ ...where, properties });
      }

      const fresh = yield* waitForProvisioned(
        `stream analytics function ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, streamingJob, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        streamanalytics.DeleteFunction({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          jobName: output.streamingJob,
          functionName: output.functionName,
        }),
      );
      yield* waitUntilGone(
        `stream analytics function ${output.functionName}`,
        getFunction(
          subscriptionId,
          output.resourceGroup,
          output.streamingJob,
          output.functionName,
        ),
      );
    }),
  });
