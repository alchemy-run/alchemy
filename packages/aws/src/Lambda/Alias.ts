import * as Lambda from "@distilled.cloud/aws/lambda";
import { deepEqual, isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  observeEventInvokeConfig,
  syncEventInvokeConfig,
  type EventInvokeConfig,
  type ObservedEventInvokeConfig,
} from "./EventInvokeConfig.ts";
import type { Version } from "./Version.ts";

export interface AliasProps {
  /**
   * Managed Lambda version that this alias invokes.
   */
  version: Version;
  /**
   * Name of the alias. If omitted, a unique name is generated.
   */
  aliasName?: string;
  /** Number of execution environments to keep initialized for this alias. */
  provisionedConcurrentExecutions?: number;
  /**
   * Description of the alias.
   */
  description?: string;
  /**
   * Weighted routing configuration for shifting traffic to an additional
   * function version.
   */
  routingConfig?: Lambda.AliasRoutingConfiguration;
  /**
   * Asynchronous invocation settings (retries, event age, destinations)
   * scoped to this alias. Omit to remove any existing alias-level config and
   * fall back to Lambda's defaults (2 retries, 6-hour max event age, no
   * destinations).
   */
  eventInvokeConfig?: EventInvokeConfig;
}

export interface Alias extends Resource<
  "AWS.Lambda.Alias",
  AliasProps,
  {
    /**
     * ARN of the Lambda alias.
     */
    aliasArn: string;
    /**
     * Name of the alias.
     */
    aliasName: string;
    /**
     * Name or ARN of the Lambda function this alias belongs to.
     */
    functionName: string;
    /**
     * Lambda function version that this alias invokes.
     */
    functionVersion: string;
    /**
     * API Gateway-compatible invocation ARN for this alias.
     */
    invokeArn: string;
    /**
     * Description of the alias.
     */
    description?: string;
    /**
     * Weighted routing configuration for this alias.
     */
    routingConfig?: Lambda.AliasRoutingConfiguration;
    /**
     * Latest Lambda revision id for this alias.
     */
    revisionId?: string;
    /**
     * Asynchronous invocation config (retries, maximum event age,
     * destinations) scoped to the alias, as observed. Lets `alchemy drift`
     * detect out-of-band changes.
     */
    eventInvokeConfig?: ObservedEventInvokeConfig;
    /** Requested provisioned concurrency for this alias, when configured. */
    provisionedConcurrentExecutions?: number;
  },
  never,
  Providers,
  AliasLookup
> {}

/**
 * Props for {@link Alias.lookup}: find an alias this stack doesn't
 * manage, in the ambient account and region.
 */
export interface AliasLookup {
  /** The function the alias points into. */
  functionName: string;
  /** The name of the existing alias. */
  aliasName: string;
}

export class InvalidAliasProps extends Data.TaggedError("InvalidAliasProps")<{
  readonly message: string;
}> {}

export class AliasProvisionedConcurrencyFailed extends Data.TaggedError(
  "AliasProvisionedConcurrencyFailed",
)<{
  readonly functionName: string;
  readonly qualifier: string;
  readonly reason?: string;
}> {}

export class AliasProvisionedConcurrencyNotReady extends Data.TaggedError(
  "AliasProvisionedConcurrencyNotReady",
)<{
  readonly functionName: string;
  readonly qualifier: string;
  readonly status?: string;
  readonly reason?: string;
}> {}

type ResolvedAliasProps = Input.ResolveProps<AliasProps>;

const resolvedProps = (props: AliasProps): ResolvedAliasProps =>
  props as unknown as ResolvedAliasProps;

/**
 * A Lambda alias for routing invocations to a stable function version.
 *
 * ### Creating Aliases
 * **Example:** Production Alias
 * ```typescript
 * const version = yield* Version("ProductionVersion", { function: fn });
 * const alias = yield* Alias("ProductionAlias", {
 *   version,
 *   aliasName: "production",
 * });
 * ```
 *
 * ### Weighted Routing
 * **Example:** Shift Traffic to Another Version
 * ```typescript
 * const version = yield* Version("LiveVersion", { function: fn });
 * const alias = yield* Alias("LiveAlias", {
 *   version,
 *   aliasName: "live",
 *   routingConfig: {
 *     AdditionalVersionWeights: {
 *       "3": 0.1,
 *     },
 *   },
 * });
 * ```
 *
 * ### Async Invocation
 * **Example:** Alias-Scoped Retry Behavior
 * ```typescript
 * const version = yield* Version("LiveVersion", { function: fn });
 * const alias = yield* Alias("LiveAlias", {
 *   version,
 *   aliasName: "live",
 *   eventInvokeConfig: {
 *     maximumRetryAttempts: 0,
 *     destinationConfig: {
 *       OnFailure: {
 *         Destination: queue.queueArn,
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * ### Provisioned Concurrency
 * **Example:** Keep an Alias Warm
 * ```typescript
 * const version = yield* Version("ProductionVersion", { function: fn });
 * const alias = yield* Alias("ProductionAlias", {
 *   version,
 *   aliasName: "production",
 *   provisionedConcurrentExecutions: 4,
 * });
 * ```
 *
 * ### Looking up an existing alias
 * `Alias.lookup` references an alias Alchemy doesn't manage (created in the
 * console or by another stack), found by `functionName` and `aliasName`. It is read during
 * plan/deploy and never created, updated or deleted.
 *
 * **Example:** Invoke an existing alias
 * ```typescript
 * const live = AWS.Lambda.Alias.lookup({ functionName: "checkout", aliasName: "live" });
 * const aliasArn = live.aliasArn;
 * ```
 *
 * @resource
 */
export const Alias = Resource<Alias>("AWS.Lambda.Alias");

const normalizeRoutingConfig = (
  config: Lambda.AliasRoutingConfiguration | undefined,
): Lambda.AliasRoutingConfiguration | undefined => {
  const weights = Object.fromEntries(
    Object.entries(config?.AdditionalVersionWeights ?? {}).filter(
      (entry): entry is [string, number] => entry[1] !== undefined,
    ),
  );
  return Object.keys(weights).length > 0 ? { AdditionalVersionWeights: weights } : undefined;
};

const validateProvisionedConcurrentExecutions = (value: number | undefined) =>
  value === undefined || (Number.isFinite(value) && Number.isInteger(value) && value >= 1)
    ? undefined
    : new InvalidAliasProps({
        message: "provisionedConcurrentExecutions must be a positive integer",
      });

export const AliasProvider = () =>
  Provider.effect(
    Alias,
    Effect.gen(function* () {
      const createAliasName = (id: string, aliasName?: string) =>
        aliasName
          ? Effect.succeed(aliasName)
          : createPhysicalName({
              id,
              maxLength: 128,
              delimiter: "-",
            });

      const retryOnAliasConflict = <A, E extends { _tag: string }, R>(
        effect: Effect.Effect<A, E, R>,
      ) =>
        effect.pipe(
          Effect.retry({
            while: (e) => e._tag === "ResourceConflictException",
            schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
          }),
        );

      const getProvisionedConcurrency = (functionName: string, qualifier: string) =>
        Lambda.getProvisionedConcurrencyConfig({
          FunctionName: functionName,
          Qualifier: qualifier,
        }).pipe(
          Effect.catchTag(
            ["ProvisionedConcurrencyConfigNotFoundException", "ResourceNotFoundException"],
            () => Effect.undefined,
          ),
        );

      const waitForProvisionedConcurrency = Effect.fn(function* (
        functionName: string,
        qualifier: string,
      ) {
        const config = yield* getProvisionedConcurrency(functionName, qualifier).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (current) => current?.Status === "READY" || current?.Status === "FAILED",
            times: 45,
          }),
        );
        if (config?.Status === "FAILED") {
          return yield* new AliasProvisionedConcurrencyFailed({
            functionName,
            qualifier,
            reason: config.StatusReason,
          });
        }
        if (config?.Status !== "READY") {
          return yield* new AliasProvisionedConcurrencyNotReady({
            functionName,
            qualifier,
            status: config?.Status,
            reason: config?.StatusReason,
          });
        }
        return config;
      });

      const waitForProvisionedConcurrencyAbsent = Effect.fn(function* (
        functionName: string,
        qualifier: string,
      ) {
        const config = yield* getProvisionedConcurrency(functionName, qualifier).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (current) => current === undefined,
            times: 45,
          }),
        );
        if (config !== undefined) {
          return yield* new AliasProvisionedConcurrencyNotReady({
            functionName,
            qualifier,
            status: config.Status,
            reason: config.StatusReason,
          });
        }
        return config;
      });

      const syncProvisionedConcurrency = Effect.fn(function* (
        functionName: string,
        qualifier: string,
        desired: number | undefined,
        managed: boolean,
        forceUpdate: boolean,
      ) {
        const observed = yield* getProvisionedConcurrency(functionName, qualifier);
        if (desired === undefined) {
          if (!managed || !observed) return observed;
          yield* Lambda.deleteProvisionedConcurrencyConfig({
            FunctionName: functionName,
            Qualifier: qualifier,
          }).pipe(
            Effect.retry({
              while: (error) => error._tag === "ResourceConflictException",
              schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
            }),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          return yield* waitForProvisionedConcurrencyAbsent(functionName, qualifier);
        }
        if (
          observed?.Status === "READY" &&
          observed.RequestedProvisionedConcurrentExecutions === desired &&
          !forceUpdate
        ) {
          return observed;
        }
        if (
          observed?.Status === "IN_PROGRESS" &&
          observed.RequestedProvisionedConcurrentExecutions === desired &&
          !forceUpdate
        ) {
          return yield* waitForProvisionedConcurrency(functionName, qualifier);
        }
        yield* Lambda.putProvisionedConcurrencyConfig({
          FunctionName: functionName,
          Qualifier: qualifier,
          ProvisionedConcurrentExecutions: desired,
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "ResourceConflictException",
            schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
          }),
        );
        return yield* waitForProvisionedConcurrency(functionName, qualifier);
      });

      const snapshotAlias = (
        functionName: string,
        alias: Lambda.AliasConfiguration,
        region: string,
        provisionedConcurrency?: Lambda.GetProvisionedConcurrencyConfigResponse,
      ): Alias["Attributes"] | undefined => {
        if (!alias.AliasArn || !alias.Name || !alias.FunctionVersion) {
          return undefined;
        }
        return {
          aliasArn: alias.AliasArn,
          aliasName: alias.Name,
          functionName,
          functionVersion: alias.FunctionVersion,
          invokeArn: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${alias.AliasArn}/invocations`,
          description: alias.Description || undefined,
          routingConfig: normalizeRoutingConfig(alias.RoutingConfig),
          revisionId: alias.RevisionId,
          provisionedConcurrentExecutions:
            provisionedConcurrency?.RequestedProvisionedConcurrentExecutions,
        };
      };

      return {
        stables: ["aliasArn", "aliasName", "functionName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          const resolvedOlds = resolvedProps(olds);
          const resolvedNews = resolvedProps(news);
          const invalidConcurrency = validateProvisionedConcurrentExecutions(
            resolvedNews.provisionedConcurrentExecutions,
          );
          if (invalidConcurrency) return yield* invalidConcurrency;
          // An interrupted create persists the Version reference as missing
          // (see stripUnresolved); there is no old function to compare.
          if (resolvedOlds.version === undefined) return;
          const oldAliasName = yield* createAliasName(id, resolvedOlds.aliasName);
          const newAliasName = yield* createAliasName(id, resolvedNews.aliasName);
          if (
            resolvedOlds.version.functionName !== resolvedNews.version.functionName ||
            oldAliasName !== newAliasName
          ) {
            return { action: "replace" } as const;
          }
        }),
        lookup: Effect.fn(function* ({ functionName, aliasName }) {
          const { region } = yield* AWSEnvironment.current;
          const alias = yield* Lambda.getAlias({
            FunctionName: functionName,
            Name: aliasName,
          }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
          const provisionedConcurrency = alias
            ? yield* getProvisionedConcurrency(functionName, aliasName)
            : undefined;
          const attrs = alias
            ? snapshotAlias(functionName, alias, region, provisionedConcurrency)
            : undefined;
          if (!attrs) return undefined;
          return {
            ...attrs,
            eventInvokeConfig: yield* observeEventInvokeConfig(functionName, attrs.aliasName),
          };
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          // An interrupted create's first checkpoint strips the Version
          // reference while the Version is still being created (see
          // stripUnresolved), so `olds.version` can be missing.
          const functionName =
            output?.functionName ?? (olds ? resolvedProps(olds).version?.functionName : undefined);
          if (!functionName) return undefined;
          const aliasName =
            output?.aliasName ??
            (yield* createAliasName(id, olds ? resolvedProps(olds).aliasName : undefined));
          const { region } = yield* AWSEnvironment.current;
          const alias = yield* Lambda.getAlias({
            FunctionName: functionName,
            Name: aliasName,
          }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
          const provisionedConcurrency = alias
            ? yield* getProvisionedConcurrency(functionName, alias.Name ?? aliasName)
            : undefined;
          const attrs = alias
            ? snapshotAlias(functionName, alias, region, provisionedConcurrency)
            : undefined;
          if (!attrs) return undefined;
          return {
            ...attrs,
            eventInvokeConfig: yield* observeEventInvokeConfig(functionName, attrs.aliasName),
          };
        }),
        list: () =>
          Effect.gen(function* () {
            const { region } = yield* AWSEnvironment.current;
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
            const aliases = yield* Effect.forEach(
              functionNames,
              (functionName) =>
                Lambda.listAliases.items({ FunctionName: functionName }).pipe(
                  Stream.runCollect,
                  Effect.flatMap((chunk) =>
                    Effect.forEach(Array.from(chunk), (alias) =>
                      Effect.gen(function* () {
                        const aliasName = alias.Name;
                        if (aliasName === undefined) return undefined;
                        const provisionedConcurrency = yield* getProvisionedConcurrency(
                          functionName,
                          aliasName,
                        );
                        const attrs = snapshotAlias(
                          functionName,
                          alias,
                          region,
                          provisionedConcurrency,
                        );
                        return attrs;
                      }),
                    ).pipe(Effect.map((items) => items.filter((item) => item !== undefined))),
                  ),
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed([] as Alias["Attributes"][]),
                  ),
                ),
              { concurrency: 10 },
            );
            return aliases.flat();
          }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const resolvedNews = resolvedProps(news);
          const invalidConcurrency = validateProvisionedConcurrentExecutions(
            resolvedNews.provisionedConcurrentExecutions,
          );
          if (invalidConcurrency) return yield* invalidConcurrency;
          const functionName = resolvedNews.version.functionName;
          const functionVersion = resolvedNews.version.version;
          const { region } = yield* AWSEnvironment.current;
          const aliasName =
            output?.aliasName ?? (yield* createAliasName(id, resolvedNews.aliasName));
          const desiredRoutingConfig = normalizeRoutingConfig(resolvedNews.routingConfig);
          const getAlias = Lambda.getAlias({
            FunctionName: functionName,
            Name: aliasName,
          }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));

          let alias = yield* getAlias;
          const aliasTargetChanged = alias?.FunctionVersion !== functionVersion;

          if (!alias) {
            alias = yield* Lambda.createAlias({
              FunctionName: functionName,
              Name: aliasName,
              FunctionVersion: functionVersion,
              Description: resolvedNews.description,
              RoutingConfig: desiredRoutingConfig,
            }).pipe(Effect.catchTag("ResourceConflictException", () => getAlias));
          }

          const observedRoutingConfig = normalizeRoutingConfig(alias?.RoutingConfig);
          if (
            !alias ||
            alias.FunctionVersion !== functionVersion ||
            (alias.Description || undefined) !== resolvedNews.description ||
            !deepEqual(observedRoutingConfig, desiredRoutingConfig)
          ) {
            alias = yield* retryOnAliasConflict(
              Lambda.updateAlias({
                FunctionName: functionName,
                Name: aliasName,
                FunctionVersion: functionVersion,
                Description: resolvedNews.description ?? "",
                RoutingConfig:
                  desiredRoutingConfig ??
                  (observedRoutingConfig ? { AdditionalVersionWeights: {} } : undefined),
              }),
            );
          }

          const attrs = snapshotAlias(functionName, alias, region);
          if (!attrs) {
            return yield* Effect.die(
              `Lambda alias ${aliasName} did not return complete attributes.`,
            );
          }

          const managed =
            resolvedNews.provisionedConcurrentExecutions !== undefined ||
            (olds !== undefined &&
              isResolved(olds) &&
              resolvedProps(olds).provisionedConcurrentExecutions !== undefined);
          const provisionedConcurrency = yield* syncProvisionedConcurrency(
            functionName,
            attrs.aliasName,
            resolvedNews.provisionedConcurrentExecutions,
            managed,
            aliasTargetChanged,
          );

          yield* syncEventInvokeConfig({
            functionName,
            qualifier: attrs.aliasName,
            config: resolvedNews.eventInvokeConfig,
          });

          yield* session.note(`Alias ${attrs.aliasName} on ${attrs.functionName}`);

          return {
            ...attrs,
            provisionedConcurrentExecutions:
              provisionedConcurrency?.RequestedProvisionedConcurrentExecutions,
            eventInvokeConfig: yield* observeEventInvokeConfig(functionName, attrs.aliasName),
          };
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          if (
            olds !== undefined &&
            isResolved(olds) &&
            resolvedProps(olds).provisionedConcurrentExecutions !== undefined
          ) {
            yield* Lambda.deleteProvisionedConcurrencyConfig({
              FunctionName: output.functionName,
              Qualifier: output.aliasName,
            }).pipe(
              Effect.retry({
                while: (error) => error._tag === "ResourceConflictException",
                schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
            yield* waitForProvisionedConcurrencyAbsent(output.functionName, output.aliasName);
          }
          // The alias-scoped async config does not die with the alias — clear
          // it first so a later alias of the same name starts clean.
          yield* syncEventInvokeConfig({
            functionName: output.functionName,
            qualifier: output.aliasName,
            config: undefined,
          });
          yield* retryOnAliasConflict(
            Lambda.deleteAlias({
              FunctionName: output.functionName,
              Name: output.aliasName,
            }),
          ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
        }),
      };
    }),
  );
