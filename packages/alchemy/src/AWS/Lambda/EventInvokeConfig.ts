import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_MAXIMUM_RETRY_ATTEMPTS = 2;
const DEFAULT_MAXIMUM_EVENT_AGE_IN_SECONDS = 21_600;

export interface EventInvokeConfigProps {
  /**
   * The name or ARN of the Lambda function.
   */
  functionName: string;
  /**
   * Lambda function version or alias name. Omit to configure the unqualified
   * function.
   */
  qualifier?: string;
  /**
   * Maximum number of times Lambda retries an asynchronous invocation.
   * @default 2
   */
  maximumRetryAttempts?: number;
  /**
   * Maximum age in seconds that Lambda retains an asynchronous event.
   * @default 21600
   */
  maximumEventAgeInSeconds?: number;
  /**
   * Destinations for successful or failed asynchronous invocation records.
   */
  destinationConfig?: Lambda.DestinationConfig;
}

export interface EventInvokeConfig extends Resource<
  "AWS.Lambda.EventInvokeConfig",
  EventInvokeConfigProps,
  {
    /**
     * The name or ARN of the Lambda function.
     */
    functionName: string;
    /**
     * Lambda function version or alias name.
     */
    qualifier?: string;
    /**
     * ARN of the function, version, or alias this config applies to.
     */
    functionArn: string;
    /**
     * Maximum number of times Lambda retries an asynchronous invocation.
     */
    maximumRetryAttempts?: number;
    /**
     * Maximum age in seconds that Lambda retains an asynchronous event.
     */
    maximumEventAgeInSeconds?: number;
    /**
     * Destinations for successful or failed asynchronous invocation records.
     */
    destinationConfig?: Lambda.DestinationConfig;
    /**
     * Last modification time reported by Lambda.
     */
    lastModified?: Date;
  },
  never,
  Providers
> {}

/**
 * Lambda asynchronous invocation settings for a function, version, or alias.
 *
 * @section Async Invocation
 * @example Configure Retry Behavior
 * ```typescript
 * const config = yield* EventInvokeConfig("AsyncInvoke", {
 *   functionName: fn.functionName,
 *   maximumRetryAttempts: 0,
 *   maximumEventAgeInSeconds: 60,
 * });
 * ```
 *
 * @example Configure Failure Destination
 * ```typescript
 * const config = yield* EventInvokeConfig("AsyncInvoke", {
 *   functionName: fn.functionName,
 *   destinationConfig: {
 *     OnFailure: {
 *       Destination: queue.queueArn,
 *     },
 *   },
 * });
 * ```
 */
export const EventInvokeConfig = Resource<EventInvokeConfig>(
  "AWS.Lambda.EventInvokeConfig",
);

const normalizeQualifier = (qualifier: string | undefined) =>
  qualifier === "$LATEST" ? undefined : qualifier;

const normalizeDestinationConfig = (
  config: Lambda.DestinationConfig | undefined,
): Lambda.DestinationConfig | undefined => {
  const onSuccess = config?.OnSuccess?.Destination
    ? { Destination: config.OnSuccess.Destination }
    : undefined;
  const onFailure = config?.OnFailure?.Destination
    ? { Destination: config.OnFailure.Destination }
    : undefined;
  return onSuccess || onFailure
    ? {
        OnSuccess: onSuccess,
        OnFailure: onFailure,
      }
    : undefined;
};

const desiredConfig = (props: EventInvokeConfigProps) => ({
  maximumRetryAttempts:
    props.maximumRetryAttempts ?? DEFAULT_MAXIMUM_RETRY_ATTEMPTS,
  maximumEventAgeInSeconds:
    props.maximumEventAgeInSeconds ?? DEFAULT_MAXIMUM_EVENT_AGE_IN_SECONDS,
  destinationConfig: normalizeDestinationConfig(props.destinationConfig),
});

const parseQualifierFromArn = (
  functionName: string,
  functionArn: string | undefined,
) => {
  if (!functionArn) return undefined;
  const marker = `:function:${functionName}:`;
  const markerIndex = functionArn.indexOf(marker);
  if (markerIndex === -1) return undefined;
  return normalizeQualifier(functionArn.slice(markerIndex + marker.length));
};

const snapshotConfig = (
  functionName: string,
  qualifier: string | undefined,
  config: Lambda.FunctionEventInvokeConfig,
): EventInvokeConfig["Attributes"] | undefined => {
  if (!config.FunctionArn) return undefined;
  return {
    functionName,
    qualifier: normalizeQualifier(qualifier),
    functionArn: config.FunctionArn,
    maximumRetryAttempts:
      config.MaximumRetryAttempts ?? DEFAULT_MAXIMUM_RETRY_ATTEMPTS,
    maximumEventAgeInSeconds:
      config.MaximumEventAgeInSeconds ?? DEFAULT_MAXIMUM_EVENT_AGE_IN_SECONDS,
    destinationConfig: normalizeDestinationConfig(config.DestinationConfig),
    lastModified: config.LastModified,
  };
};

export const EventInvokeConfigProvider = () =>
  Provider.effect(
    EventInvokeConfig,
    Effect.gen(function* () {
      const retryOnConflict = <A, E extends { _tag: string }, R>(
        effect: Effect.Effect<A, E, R>,
      ) =>
        effect.pipe(
          Effect.retry({
            while: (e) => e._tag === "ResourceConflictException",
            schedule: Schedule.exponential(500).pipe(
              Schedule.both(Schedule.recurs(10)),
            ),
          }),
        );

      const retryPermissionsPropagation = Effect.retry({
        while: (e: any) =>
          e._tag === "InvalidParameterValueException" &&
          e.message?.includes(
            "The function execution role does not have permissions to call",
          ),
        schedule: Schedule.exponential(100).pipe(
          Schedule.both(Schedule.recurs(30)),
        ),
      }) as <A, R, Err>(
        self: Effect.Effect<A, Err, R>,
      ) => Effect.Effect<A, Err, R>;

      const getConfig = (functionName: string, qualifier: string | undefined) =>
        Lambda.getFunctionEventInvokeConfig({
          FunctionName: functionName,
          Qualifier: normalizeQualifier(qualifier),
        }).pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      const putConfig = (props: EventInvokeConfigProps) =>
        retryOnConflict(
          Lambda.putFunctionEventInvokeConfig({
            FunctionName: props.functionName,
            Qualifier: normalizeQualifier(props.qualifier),
            MaximumRetryAttempts: props.maximumRetryAttempts,
            MaximumEventAgeInSeconds: props.maximumEventAgeInSeconds,
            DestinationConfig: normalizeDestinationConfig(
              props.destinationConfig,
            ),
          }).pipe(retryPermissionsPropagation),
        );

      return {
        stables: ["functionName", "qualifier", "functionArn"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (
            news.functionName !== olds.functionName ||
            normalizeQualifier(news.qualifier) !==
              normalizeQualifier(olds.qualifier)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const functionName = output?.functionName ?? olds?.functionName;
          if (!functionName) return undefined;
          const qualifier = output?.qualifier ?? olds?.qualifier;
          const config = yield* getConfig(functionName, qualifier);
          return config
            ? snapshotConfig(functionName, qualifier, config)
            : undefined;
        }),
        list: () =>
          Effect.gen(function* () {
            const functionNames = yield* Lambda.listFunctions.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Functions ?? [])
                    .map((fn) => fn.FunctionName)
                    .filter((name): name is string => name !== undefined),
                ),
              ),
            );

            const configs = yield* Effect.forEach(
              functionNames,
              (functionName) =>
                Lambda.listFunctionEventInvokeConfigs
                  .items({ FunctionName: functionName })
                  .pipe(
                    Stream.runCollect,
                    Effect.map((chunk) =>
                      Array.from(chunk).flatMap((config) => {
                        const attrs = snapshotConfig(
                          functionName,
                          parseQualifierFromArn(
                            functionName,
                            config.FunctionArn,
                          ),
                          config,
                        );
                        return attrs ? [attrs] : [];
                      }),
                    ),
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed([] as EventInvokeConfig["Attributes"][]),
                    ),
                  ),
              { concurrency: 10 },
            );
            return configs.flat();
          }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const qualifier = normalizeQualifier(news.qualifier);
          const desired = desiredConfig(news);
          let config = yield* getConfig(news.functionName, qualifier);
          const current = config
            ? snapshotConfig(news.functionName, qualifier, config)
            : undefined;

          if (
            !current ||
            current.maximumRetryAttempts !== desired.maximumRetryAttempts ||
            current.maximumEventAgeInSeconds !==
              desired.maximumEventAgeInSeconds ||
            !deepEqual(current.destinationConfig, desired.destinationConfig)
          ) {
            config = yield* putConfig(news);
          }

          if (!config) {
            return yield* Effect.die(
              `Lambda event invoke config for ${news.functionName} could not be reconciled.`,
            );
          }

          const attrs = snapshotConfig(news.functionName, qualifier, config);
          if (!attrs) {
            return yield* Effect.die(
              `Lambda event invoke config for ${news.functionName} did not return complete attributes.`,
            );
          }

          yield* session.note(
            `Event invoke config on ${attrs.functionName}${attrs.qualifier ? `:${attrs.qualifier}` : ""}`,
          );

          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOnConflict(
            Lambda.deleteFunctionEventInvokeConfig({
              FunctionName: output.functionName,
              Qualifier: normalizeQualifier(output.qualifier),
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );
