import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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

/** A pipeline a trigger starts, with the arguments it passes. */
export interface TriggerPipeline {
  /** Name of the pipeline to run. */
  pipelineName: string;
  /** Arguments for the pipeline's parameters. */
  parameters?: Record<string, unknown>;
}

export interface TriggerProps {
  /** Resource group of the factory. Changing it replaces the trigger. */
  resourceGroup: string;
  /** Name of the factory that holds the trigger. Changing it replaces the trigger. */
  factoryName: string;
  /**
   * Trigger name: up to 260 characters, starting with a letter, digit, or
   * `_`, without `< > * # . % & : \ + ? /`. If omitted, a unique name of
   * letters, digits, and `_` is generated from the app, stage, and logical
   * ID. Changing it replaces the trigger.
   */
  name?: string;
  /**
   * Trigger type, e.g. `ScheduleTrigger`, `TumblingWindowTrigger`,
   * `BlobEventsTrigger`, `CustomEventsTrigger`. Changing it replaces the
   * trigger.
   */
  type: string;
  /**
   * Type-specific properties as documented for the trigger type, e.g.
   * `{ recurrence: { frequency: "Day", interval: 1, startTime, timeZone } }`
   * for a `ScheduleTrigger`.
   */
  typeProperties?: Record<string, unknown>;
  /**
   * Pipelines the trigger starts. Schedule and event triggers accept many;
   * a `TumblingWindowTrigger` accepts exactly one.
   */
  pipelines?: TriggerPipeline[];
  /**
   * Whether the trigger is started. Updating a started trigger stops it,
   * applies the definition, and starts it again.
   * @default true
   */
  started?: boolean;
  /** Trigger description. */
  description?: string;
  /**
   * Annotations shown in the authoring UI. Alchemy appends an ownership
   * annotation (`alchemy:<stack>/<stage>/<id>`).
   */
  annotations?: string[];
}

export interface Trigger extends Resource<
  "Azure.DataFactory.Trigger",
  TriggerProps,
  {
    /** Name of the trigger. */
    triggerName: string;
    /** Name of the factory that holds the trigger. */
    factoryName: string;
    /** Resource group of the factory. */
    resourceGroup: string;
    /** ARM resource ID of the trigger. */
    triggerId: string;
    /** Trigger type. */
    type: string;
    /** Runtime state: `Started`, `Stopped`, or `Disabled`. */
    runtimeState: string | undefined;
    /** Entity tag of the current definition. */
    etag: string | undefined;
    /** User annotations (Alchemy ownership annotation stripped). */
    annotations: unknown[];
  },
  never,
  Providers
> {}

/**
 * A Data Factory trigger — starts pipeline runs on a schedule, over
 * tumbling time windows, or in response to storage or custom events.
 *
 * Alchemy starts the trigger after deploying it (set `started: false` to
 * keep it stopped) and stops it before updating or deleting it, because
 * Data Factory rejects changes to a started trigger.
 *
 * @see https://learn.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers
 *
 * ### Scheduling Pipelines
 * **Example:** Run a pipeline every day at 02:00 UTC
 * ```typescript
 * const nightly = yield* Azure.DataFactory.Trigger("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   type: "ScheduleTrigger",
 *   typeProperties: {
 *     recurrence: {
 *       frequency: "Day",
 *       interval: 1,
 *       startTime: "2026-01-01T02:00:00Z",
 *       timeZone: "UTC",
 *     },
 *   },
 *   pipelines: [{ pipelineName: pipeline.pipelineName }],
 * });
 * ```
 *
 * **Example:** Defined but stopped
 * ```typescript
 * const paused = yield* Azure.DataFactory.Trigger("paused", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   type: "ScheduleTrigger",
 *   typeProperties: {
 *     recurrence: { frequency: "Hour", interval: 1, startTime: "2026-01-01T00:00:00Z" },
 *   },
 *   pipelines: [{ pipelineName: pipeline.pipelineName }],
 *   started: false,
 * });
 * ```
 *
 * @resource
 */
export const Trigger = Resource<Trigger>("Azure.DataFactory.Trigger");

export class TriggerStateTimedOut extends Data.TaggedError(
  "Azure.DataFactory.TriggerStateTimedOut",
)<{
  readonly trigger: string;
  readonly state: string | undefined;
  readonly message: string;
}> {}

const getTrigger = (
  subscriptionId: string,
  resourceGroupName: string,
  factoryName: string,
  triggerName: string,
) =>
  orUndefinedIfNotFound(
    datafactory.GetTrigger({
      subscriptionId,
      resourceGroupName,
      factoryName,
      triggerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  factoryName: string,
  name: string,
  observed: datafactory.GetTriggerResponse,
): Trigger["Attributes"] => ({
  triggerName: name,
  factoryName,
  resourceGroup,
  triggerId: observed.id ?? "",
  type: observed.properties.type,
  runtimeState: observed.properties.runtimeState,
  etag: observed.etag,
  annotations: userAnnotations(observed.properties.annotations),
});

const toPipelines = (pipelines: TriggerPipeline[] | undefined) =>
  pipelines?.map((p) => ({
    pipelineReference: {
      type: "PipelineReference",
      referenceName: p.pipelineName,
    },
    parameters: p.parameters,
  }));

/**
 * Start/Stop are long-running actions; poll the trigger until it reports
 * the target runtime state.
 */
const waitForRuntimeState = <E, R>(
  name: string,
  get: Effect.Effect<datafactory.GetTriggerResponse | undefined, E, R>,
  target: "Started" | "Stopped",
) =>
  get.pipe(
    Effect.repeat({
      until: (t) => t?.properties.runtimeState === target,
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
    Effect.flatMap((t) =>
      t?.properties.runtimeState === target
        ? Effect.succeed(t)
        : Effect.fail(
            new TriggerStateTimedOut({
              trigger: name,
              state: t?.properties.runtimeState,
              message: `trigger ${name} did not reach '${target}' (last state: ${t?.properties.runtimeState ?? "not found"})`,
            }),
          ),
    ),
  );

export const TriggerProvider = () =>
  Provider.succeed(Trigger, {
    stables: [
      "triggerName",
      "factoryName",
      "resourceGroup",
      "triggerId",
      "type",
    ],

    // Triggers live inside a factory; nuke removes them with it.
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
          news.name.toLowerCase() !== output.triggerName.toLowerCase()) ||
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
        output?.triggerName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getTrigger(
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
        news.name ?? output?.triggerName ?? (yield* createChildName(id));
      const started = news.started ?? true;
      const marker = yield* ownershipAnnotation(id);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        factoryName,
        triggerName: name,
      };
      const get = getTrigger(subscriptionId, resourceGroup, factoryName, name);
      const pipelines = toPipelines(news.pipelines);
      const singlePipeline = news.type === "TumblingWindowTrigger";
      const desired = {
        type: news.type,
        typeProperties: news.typeProperties,
        pipelines: singlePipeline ? undefined : pipelines,
        pipeline: singlePipeline ? pipelines?.[0] : undefined,
        description: news.description,
        annotations: annotationsWithOwnership(news.annotations, marker),
      };

      // Observe.
      let observed = yield* get;

      // Ensure + sync the definition. A started trigger rejects updates, so
      // stop it first.
      if (
        observed === undefined ||
        definitionDiffers(desired, observed.properties)
      ) {
        if (observed?.properties.runtimeState === "Started") {
          yield* datafactory.StopTrigger(where);
          yield* waitForRuntimeState(name, get, "Stopped");
        }
        observed = yield* datafactory.TriggersCreateOrUpdate({
          ...where,
          properties: desired,
        });
      }

      // Sync the runtime state against the observed state.
      const state = observed.properties.runtimeState;
      if (started && state !== "Started") {
        yield* datafactory.StartTrigger(where);
        observed = yield* waitForRuntimeState(name, get, "Started");
      } else if (!started && state === "Started") {
        yield* datafactory.StopTrigger(where);
        observed = yield* waitForRuntimeState(name, get, "Stopped");
      }

      return toAttrs(resourceGroup, factoryName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        factoryName: output.factoryName,
        triggerName: output.triggerName,
      };
      const get = getTrigger(
        subscriptionId,
        output.resourceGroup,
        output.factoryName,
        output.triggerName,
      );
      // A started trigger cannot be deleted.
      const observed = yield* get;
      if (observed === undefined) return;
      if (observed.properties.runtimeState === "Started") {
        yield* ignoreNotFound(datafactory.StopTrigger(where));
        yield* waitForRuntimeState(output.triggerName, get, "Stopped").pipe(
          Effect.catchTag("Azure.DataFactory.TriggerStateTimedOut", (e) =>
            e.state === undefined ? Effect.void : Effect.fail(e),
          ),
        );
      }
      yield* ignoreNotFound(datafactory.DeleteTrigger(where));
      yield* waitUntilGone(`trigger ${output.triggerName}`, get);
    }),

    nuke: {
      dependsOn: ["Azure.DataFactory.Pipeline", "Azure.DataFactory.Factory"],
    },
  });
