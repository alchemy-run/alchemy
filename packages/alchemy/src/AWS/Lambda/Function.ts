import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as iam from "@distilled.cloud/aws/iam";
import type { CreateFunctionRequest } from "@distilled.cloud/aws/lambda";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { Region } from "@distilled.cloud/aws/Region";
import type * as lambda from "aws-lambda";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import {
  hashPackageInstallIdentity,
  installResolvedPackages,
  matchesPackageRoot,
  normalizeInstallTargets,
  resolvePackageInstallIdentity,
  type PackageInstall,
} from "../../Bundle/InstalledPackages.ts";
import * as TempRoot from "../../Bundle/TempRoot.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import type { LogLine, LogsInput } from "../../Provider.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { Self } from "../../Self.ts";
import * as Serverless from "../../Serverless/index.ts";
import { Stack } from "../../Stack.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
  hasTags,
} from "../../Tags.ts";
import { sha256 } from "../../Util/sha256.ts";
import { zipCode } from "../../Util/zip.ts";
import { Assets } from "../Assets.ts";
import { AWSEnvironment } from "../Environment.ts";
import * as IAM from "../IAM/index.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import { makeFunctionHttpHandler } from "./HttpServer.ts";

export const FunctionTypeId = "AWS.Lambda.Function" as const;
export type FunctionTypeId = typeof FunctionTypeId;

export class HandlerContext extends Context.Service<
  HandlerContext,
  lambda.Context
>()("AWS.Lambda.HandlerContext") {}

export const isFunction = (value: any): value is Function => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "AWS.Lambda.Function"
  );
};

export interface FunctionBuildOptions extends Partial<rolldown.InputOptions> {
  /**
   * Native or Node-only packages to install into the Lambda artifact with npm,
   * targeting Linux and the function's architecture.
   *
   * @example
   * ```typescript
   * build: { install: ["sharp"] }
   * ```
   *
   * @example
   * ```typescript
   * build: { install: { sharp: "^0.33.5" } }
   * ```
   */
  readonly install?: PackageInstall;
  readonly output?: Partial<rolldown.OutputOptions>;
}

export type FunctionArchitecture = "x86_64" | "arm64";

export interface FunctionUrlConfig {
  /**
   * Authentication type for the Lambda function URL.
   * `NONE` creates a public endpoint. `AWS_IAM` requires SigV4-signed callers.
   * @default "NONE"
   */
  authType?: Lambda.FunctionUrlAuthType;
  /**
   * Cross-origin resource sharing configuration for the function URL.
   */
  cors?: Lambda.Cors;
  /**
   * Invocation mode for the function URL.
   * @default "BUFFERED"
   */
  invokeMode?: Lambda.InvokeMode;
}

export interface FunctionProps extends PlatformProps {
  /**
   * Entry module for the bundled Lambda function.
   */
  main: string;
  /**
   * Exported handler symbol inside the bundled module.
   * @default "handler"
   */
  handler?: string;
  /**
   * Whether to create a Lambda function URL, or its configuration.
   * `true` creates a public Function URL with `authType: "NONE"`.
   * Set `false` to disable the Function URL.
   * @default true
   */
  url?: boolean | FunctionUrlConfig;
  functionName?: string;
  // TODO(sam): use a Layer instead so we can manage Effect platform?
  runtime?: "nodejs22.x" | "nodejs24.x";
  /**
   * Instruction set architecture for the Lambda function.
   *
   * @default "x86_64"
   */
  architecture?: FunctionArchitecture;
  memorySize?: number;
  build?: FunctionBuildOptions;
  uploadSourceMap?: boolean;
  env?: Record<string, any>;
  exports?: string[];
  /**
   * Attach the function to a VPC for private AWS connectivity such as Aurora.
   */
  vpc?: {
    subnetIds: string[];
    securityGroupIds: string[];
  };
  /**
   * Maximum execution time before the function is forcibly terminated.
   * Rounded up to whole seconds.
   *
   * @default 3 seconds (AWS Lambda default)
   */
  timeout?: Duration.Duration;
  /**
   * Maximum number of concurrent executions reserved for this function.
   * Omit to remove the function-level reserved concurrency limit.
   */
  reservedConcurrentExecutions?: number;
}

/**
 * Normalize a {@link FunctionProps.timeout} to whole seconds.
 *
 * State JSON round-trips flatten a `Duration` to its `toJSON` shape
 * (`{_id:"Duration",_tag:"Millis"|"Nanos"|"Infinity",...}`), which is not a
 * valid `Duration.Input`. Reconstruct an input that `Duration.toSeconds`
 * accepts before delegating.
 */
export const toTimeoutSeconds = (
  timeout: Duration.Duration | undefined,
): number | undefined => {
  if (timeout === undefined) return undefined;
  const json = timeout as {
    _id?: unknown;
    _tag?: "Millis" | "Nanos" | "Infinity" | "NegativeInfinity";
    millis?: number;
    nanos?: string;
  };
  const input: Duration.Input =
    json._id === "Duration"
      ? json._tag === "Millis"
        ? json.millis!
        : json._tag === "Nanos"
          ? BigInt(json.nanos!)
          : "Infinity"
      : timeout;
  const seconds = Duration.toSeconds(input);
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : undefined;
};

export interface Function extends Resource<
  FunctionTypeId,
  FunctionProps,
  {
    functionArn: string;
    functionName: string;
    functionUrl: string | undefined;
    roleName: string;
    roleArn: string;
    code: {
      hash: string;
    };
    reservedConcurrentExecutions?: number;
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  },
  Providers
> {}

export type FunctionServices = Credentials | Region | AWSEnvironment;

export type FunctionShape = Main<FunctionServices>;

interface NormalizedFunctionUrlConfig {
  authType: Lambda.FunctionUrlAuthType;
  cors?: Lambda.Cors;
  invokeMode: Lambda.InvokeMode;
}

const normalizeFunctionUrl = (
  url: FunctionProps["url"] = true,
): NormalizedFunctionUrlConfig | undefined => {
  if (url === false) {
    return undefined;
  }
  if (url === true || url === undefined) {
    return {
      authType: "NONE",
      invokeMode: "BUFFERED",
    };
  }
  return {
    authType: url.authType ?? "NONE",
    cors: url.cors,
    invokeMode: url.invokeMode ?? "BUFFERED",
  };
};

/**
 * Evaluates a user-supplied Rolldown `external` option (string, RegExp, array,
 * or predicate) for a single module id, preserving its original semantics.
 */
const matchesConfiguredExternal = (
  external: rolldown.InputOptions["external"],
  moduleId: string,
  parentId: string | undefined,
  isResolved: boolean,
): boolean => {
  if (external === undefined) return false;
  if (typeof external === "function") {
    return external(moduleId, parentId, isResolved) === true;
  }
  const matchers = Array.isArray(external) ? external : [external];
  return matchers.some((matcher) =>
    typeof matcher === "string" ? matcher === moduleId : matcher.test(moduleId),
  );
};

/**
 * An AWS Lambda host resource that combines code bundling, IAM role
 * provisioning, and runtime binding collection.
 *
 * `Function` is the canonical runtime host for AWS. Alchemy automatically
 * bundles your TypeScript entry module with Rolldown, creates an IAM
 * execution role, and uploads the zip artifact. On subsequent deploys, the
 * function is only updated when the bundle hash changes.
 *
 * There are two ways to define a Lambda Function:
 *
 * - **Async** — plain handler export, no Effect runtime in the bundle.
 * - **Effect** — Effect implementation with typed bindings and event sources.
 *
 * See the {@link https://alchemy.run/guides/async-lambda | Async Lambda Guide}
 * for plain handler patterns, or the
 * {@link https://alchemy.run/guides/lambda | Effect Lambda Guide}
 * for the full Effect-based approach with bindings, event sources, and sinks.
 * @resource
 * @section Async Functions
 * Point `main` at a file that exports a standard Lambda handler. No
 * Effect runtime is included in the bundle. Useful when migrating
 * existing Lambda functions or when you don't need Effect.
 *
 * @example Defining an async Lambda in your stack
 * ```typescript
 * // alchemy.run.ts
 * import * as AWS from "alchemy/AWS";
 *
 * const func = yield* AWS.Lambda.Function("ApiFunction", {
 *   main: "./src/handler.ts",
 *   url: true,
 * });
 * ```
 *
 * @example Function using ARM64
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ArmFunction", {
 *   main: "./src/handler.ts",
 *   architecture: "arm64",
 * });
 * ```
 *
 * @example Function with a native package (Sharp)
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ImageProcessor", {
 *   main: "./src/handler.ts",
 *   architecture: "arm64",
 *   build: {
 *     install: ["sharp"],
 *   },
 * });
 * ```
 *
 * @example Writing the async handler
 * ```typescript
 * // src/handler.ts
 * export const handler = async (event: any) => {
 *   return {
 *     statusCode: 200,
 *     body: JSON.stringify({ message: "Hello from Lambda!" }),
 *   };
 * };
 * ```
 *
 * @section Effect Functions
 * Pass the Effect implementation as the third argument. Bindings
 * attach IAM permissions and environment variables at deploy time,
 * while the runtime execution context collects listeners and exports.
 *
 * @example Effect Function with HTTP handler
 * ```typescript
 * export default class ApiFunction extends AWS.Lambda.Function<ApiFunction>()(
 *   "ApiFunction",
 *   { main: import.meta.filename, url: true },
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const getItem = yield* AWS.DynamoDB.GetItem(table);
 *
 *     return {
 *       // runtime: use them
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const url = new URL(request.url);
 *         const id = url.searchParams.get("id");
 *         const result = yield* getItem({ Key: { pk: { S: id! } } });
 *         return yield* HttpServerResponse.json(result.Item);
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @section Configuration
 * @example Function with URL
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ApiFunction", {
 *   main: "./src/handler.ts",
 *   url: true,
 * });
 * ```
 *
 * @example Function URL with IAM auth
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ApiFunction", {
 *   main: "./src/handler.ts",
 *   url: {
 *     authType: "AWS_IAM",
 *   },
 * });
 * ```
 *
 * @example Function in a VPC
 * ```typescript
 * const func = yield* AWS.Lambda.Function("VpcFunction", {
 *   main: "./src/handler.ts",
 *   vpc: {
 *     subnetIds: ["subnet-abc123", "subnet-def456"],
 *     securityGroupIds: ["sg-xyz789"],
 *   },
 * });
 * ```
 *
 * @section S3 Bindings
 * Bind S3 operations in the init phase to give the function IAM
 * permissions and inject the bucket name as an environment variable.
 *
 * @example Read and write S3 objects
 * ```typescript
 * // init
 * const getObject = yield* S3.GetObject(bucket);
 * const putObject = yield* S3.PutObject(bucket);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* putObject({ Key: "hello.txt", Body: "Hello!" });
 *     const obj = yield* getObject({ Key: "hello.txt" });
 *     return HttpServerResponse.text("OK");
 *   }),
 * };
 * ```
 *
 * @section DynamoDB Bindings
 * Bind DynamoDB operations in the init phase to grant table-scoped
 * IAM permissions.
 *
 * @example Get and put items
 * ```typescript
 * // init
 * const getItem = yield* AWS.DynamoDB.GetItem(table);
 * const putItem = yield* AWS.DynamoDB.PutItem(table);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* putItem({ Item: { pk: { S: "user#1" }, name: { S: "Alice" } } });
 *     const result = yield* getItem({ Key: { pk: { S: "user#1" } } });
 *     return yield* HttpServerResponse.json(result.Item);
 *   }),
 * };
 * ```
 *
 * @section SQS Bindings
 * Bind SQS operations in the init phase to send messages to a queue.
 *
 * @example Send a message
 * ```typescript
 * // init
 * const sendMessage = yield* SQS.SendMessage(queue);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* sendMessage({
 *       MessageBody: JSON.stringify({ orderId: "123" }),
 *     });
 *     return HttpServerResponse.text("Queued");
 *   }),
 * };
 * ```
 *
 * @section SNS Bindings
 * Bind SNS operations in the init phase to publish messages to a
 * topic.
 *
 * @example Publish a notification
 * ```typescript
 * // init
 * const publish = yield* AWS.SNS.Publish(topic);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* publish({
 *       Message: JSON.stringify({ event: "order.created" }),
 *       Subject: "OrderCreated",
 *     });
 *     return HttpServerResponse.text("Published");
 *   }),
 * };
 * ```
 *
 * @section Kinesis Bindings
 * Bind Kinesis operations in the init phase to put records into a
 * stream.
 *
 * @example Put a record
 * ```typescript
 * // init
 * const putRecord = yield* AWS.Kinesis.PutRecord(stream);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* putRecord({
 *       PartitionKey: "order-123",
 *       Data: new TextEncoder().encode(JSON.stringify({ orderId: "123" })),
 *     });
 *     return HttpServerResponse.text("Sent");
 *   }),
 * };
 * ```
 *
 * @section Event Sources
 * Lambda functions can be triggered by event sources like SQS queues,
 * DynamoDB streams, S3 notifications, SNS topics, and Kinesis streams.
 *
 * @example Process SQS messages
 * ```typescript
 * yield* SQS.consumeQueueMessages(queue,
 *   Effect.fn(function* (message) {
 *     yield* Effect.log(`Received: ${message.body}`);
 *   }),
 * );
 * ```
 *
 * @example Process DynamoDB stream changes
 * ```typescript
 * yield* AWS.DynamoDB.consumeTableChanges(table, {
 *   StreamViewType: "NEW_AND_OLD_IMAGES",
 * },
 *   Effect.fn(function* (record) {
 *     yield* Effect.log(`Change: ${record.eventName}`);
 *   }),
 * );
 * ```
 *
 * @example Process S3 notifications
 * ```typescript
 * yield* AWS.S3.consumeBucketEvents(bucket, {
 *   events: ["s3:ObjectCreated:*"],
 * }, (stream) =>
 *   stream.pipe(
 *     Stream.runForEach((event) =>
 *       Effect.log(`New object: ${event.key}`),
 *     ),
 *   ),
 * );
 * ```
 */
export const Function: Platform<
  Function,
  FunctionServices,
  FunctionShape,
  Serverless.FunctionContext
> = Platform(FunctionTypeId, {
  createRuntimeContext: (id: string): Serverless.FunctionContext => {
    const listeners: Effect.Effect<Serverless.FunctionListener>[] = [];
    const env: Record<string, any> = {};

    const ctx = {
      Type: FunctionTypeId,
      id,
      env,
      set: (id: string, output: Output.Output) =>
        Effect.sync(() => {
          // Key is already canonical (see RuntimeContext.sanitizeKey); store it
          // verbatim.
          const key = id;
          // Preserve `Redacted`-ness across the Output → Lambda env var
          // round-trip. `JSON.stringify(Redacted)` would emit the literal
          // string `"<redacted>"` and lose the value, so secrets are
          // serialized with a `{_tag: "Redacted", value: ...}` marker
          // that the runtime `get` path detects and rebuilds.
          env[key] = output.pipe(
            Output.map((value) =>
              Redacted.isRedacted(value)
                ? JSON.stringify({
                    _tag: "Redacted",
                    value: Redacted.value(value),
                  })
                : JSON.stringify(value),
            ),
          );
          return key;
        }),
      get: <T>(key: string) =>
        // Read the captured value straight from `process.env`. We must NOT
        // resolve through `Config.string` here: at runtime the ambient
        // `ConfigProvider` is the interceptor installed in `Platform.ts`,
        // whose runtime branch calls back into `ctx.get(key)`. Going through
        // `Config` would re-enter that interceptor for the same key and
        // recurse forever, allocating until the Lambda init OOMs. The Worker
        // runtime reads from `WorkerEnvironment` for the same reason.
        Effect.sync(() => {
          // Key is already canonical (see RuntimeContext.sanitizeKey).
          const val = process.env[key];
          if (val === undefined) {
            return undefined;
          }
          try {
            const value = JSON.parse(val);
            if (
              typeof value === "object" &&
              value?._tag === "Redacted" &&
              "value" in value
            ) {
              return Redacted.make(
                (value as { value: unknown }).value,
              ) as unknown as T;
            }
            return value as T;
          } catch {
            return val as unknown as T; // assume it's just a string
          }
        }),
      serve: (handler: HttpEffect) =>
        // @ts-ignore
        ctx.listen(makeFunctionHttpHandler(handler)),
      listen: ((
        handler:
          | Serverless.FunctionListener
          | Effect.Effect<Serverless.FunctionListener>,
      ) =>
        Effect.sync(() =>
          Effect.isEffect(handler)
            ? listeners.push(handler)
            : listeners.push(Effect.succeed(handler)),
        )) as any as Serverless.FunctionContext["listen"],
      exports: Effect.sync(() => ({
        // construct an Effect that produces the Function's entrypoint
        // Effect<(event, context) => Promise<any>>
        handler: Effect.map(
          Effect.all(listeners, {
            concurrency: "unbounded",
          }),
          (handlers) =>
            async (event: any, context: lambda.Context): Promise<any> => {
              for (const handler of handlers) {
                const eff = handler(event);
                if (Effect.isEffect(eff)) {
                  return await eff.pipe(
                    Effect.provideService(HandlerContext, context),
                    Effect.tap(Effect.logDebug),
                    Effect.runPromise,
                  );
                }
              }
              throw new Error("No event handler found");
            },
        ),
      })),
    };
    return ctx;
  },
});

export const FunctionProvider = () =>
  Provider.effect(
    Function,
    Effect.gen(function* () {
      const stack = yield* Stack;

      const fs = yield* FileSystem.FileSystem;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      const createFunctionName = (
        id: string,
        functionName: string | undefined,
      ) =>
        Effect.gen(function* () {
          return (
            functionName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
          );
        });

      const createRoleName = (id: string) =>
        createPhysicalName({ id, maxLength: 64 });

      const createPolicyName = (id: string) =>
        createPhysicalName({ id, maxLength: 128 });

      const hashBundle = (code: Uint8Array<ArrayBufferLike>) => sha256(code);

      const createNames = (id: string, functionName: string | undefined) =>
        Effect.gen(function* () {
          const { accountId, region } = yield* AWSEnvironment.current;
          const roleName = yield* createRoleName(id);
          const policyName = yield* createPolicyName(id);
          const fn = yield* createFunctionName(id, functionName);
          return {
            roleName,
            policyName,
            functionName: fn,
            roleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
            functionArn: `arn:aws:lambda:${region}:${accountId}:function:${fn}`,
          };
        });

      const attachBindings = Effect.fn(function* ({
        roleName,
        policyName,
        // functionArn,
        // functionName,
        bindings,
      }: {
        roleName: string;
        policyName: string;
        functionArn: string;
        functionName: string;
        bindings: ResourceBinding<Function["Binding"]>[];
      }) {
        const activeBindings = bindings.filter(
          (
            binding: ResourceBinding<Function["Binding"]> & { action?: string },
          ) => binding.action !== "delete",
        );
        const env = activeBindings
          .map((binding) => binding?.data?.env)
          .reduce((acc, env) => ({ ...acc, ...env }), {});
        const policyStatements = activeBindings.flatMap(
          (binding) =>
            binding?.data?.policyStatements?.map(
              (stmt: IAM.PolicyStatement) => ({
                ...stmt,
                Sid: stmt.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
              }),
            ) ?? [],
        );

        if (policyStatements.length > 0) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: policyName,
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: policyStatements,
            } satisfies IAM.PolicyDocument),
          });
        } else {
          yield* iam
            .deleteRolePolicy({
              RoleName: roleName,
              PolicyName: policyName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }

        return env;
      });

      const createRoleIfNotExists = Effect.fn(function* ({
        id,
        roleName,
        vpc,
      }: {
        id: string;
        roleName: string;
        vpc?: FunctionProps["vpc"];
      }) {
        yield* Effect.logDebug(`creating role ${id}`);
        const tags = yield* createInternalTags(id);
        // Engine has cleared us via `read` — foreign-tagged functions are
        // surfaced as `Unowned` and require `--adopt`. On a race between
        // read and create, treat `EntityAlreadyExistsException` as adoption.
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: {
                    Service: "lambda.amazonaws.com",
                  },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: createTagsList(tags),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({
                RoleName: roleName,
              }),
            ),
          );

        yield* Effect.logDebug(`attaching policy ${id}`);
        yield* iam
          .attachRolePolicy({
            RoleName: roleName,
            PolicyArn:
              "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          })
          .pipe(Effect.tapError(Effect.logDebug), Effect.tap(Effect.logDebug));

        if (vpc) {
          yield* iam
            .attachRolePolicy({
              RoleName: roleName,
              PolicyArn:
                "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.tap(Effect.logDebug),
            );
        }

        yield* Effect.logDebug(`attached policy ${id}`);
        return role;
      });

      const bundleCode = Effect.fn(function* (
        id: string,
        props: FunctionProps,
      ) {
        const {
          output: buildOutput,
          install,
          ...inputOptions
        } = props.build ?? {};
        const sourcemap = buildOutput?.sourcemap ?? true;
        const uploadSourceMap = props.uploadSourceMap ?? true;

        const realMain = yield* fs.realPath(props.main);
        const cwd = yield* TempRoot.findCwdForBundle(realMain);

        const rolldownSourcemap = sourcemap;
        const architecture = props.architecture ?? "x86_64";

        // Explicit install roots are excluded from the bundle and installed
        // into the deployment artifact. build.external stays a pure Rolldown
        // escape hatch and is not installed by Alchemy.
        const requested = yield* normalizeInstallTargets(install);
        const installRoots = new Set(Object.keys(requested));
        const configuredExternal = inputOptions.external;
        const externalOption = (
          moduleId: string,
          parentId: string | undefined,
          isResolved: boolean,
        ): boolean => {
          if (moduleId.startsWith("@aws-sdk/")) return true;
          for (const root of installRoots) {
            if (matchesPackageRoot(moduleId, root)) return true;
          }
          return matchesConfiguredExternal(
            configuredExternal,
            moduleId,
            parentId,
            isResolved,
          );
        };

        const buildBundle = Effect.fn(function* (
          entry: string,
          plugins?: rolldown.RolldownPluginOption,
        ) {
          return yield* Bundle.build(
            {
              ...inputOptions,
              input: entry,
              cwd,
              external: externalOption,
              platform: "node",
              plugins: [inputOptions.plugins, plugins],
            },
            {
              ...buildOutput,
              format: "esm",
              sourcemap: rolldownSourcemap,
              minify: buildOutput?.minify ?? false,
              entryFileNames: "index.js",
              codeSplitting: buildOutput?.codeSplitting ?? false,
            },
          );
        });

        const bundleOutput = props.isExternal
          ? yield* buildBundle(realMain)
          : yield* buildBundle(
              realMain,
              virtualEntryPlugin(
                (importPath) => `
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer } from "alchemy/Runtime";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import { layer as fetchHttpClientLayer } from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "@distilled.cloud/aws/Region";
import * as Context from "effect/Context";
import { MinimumLogLevel } from "effect/References";

import entrypoint from ${JSON.stringify(importPath)};

const tag = Context.Service("${Self.key}")
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  nodeServicesLayer,
  fetchHttpClientLayer,
  // TODO(sam): wire this up to telemetry more directly
  Logger.layer([Logger.consolePretty()]),
);

const stack = Layer.effect(
  Stack,
  Effect.all([
    Config.string("ALCHEMY_STACK_NAME"),
    Config.string("ALCHEMY_STAGE")
  ]).pipe(
    Effect.map(([name, stage]) => ({
      name,
      stage,
      bindings: {},
      resources: {}
    }))
  )
);

const handlerEffect = tag.pipe(
  Effect.flatMap(func => func.RuntimeContext.exports),
  Effect.flatMap(exports => exports.handler),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      Layer.provideMerge(Credentials.fromEnv()),
      Layer.provideMerge(Region.fromEnv()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv()
        )
      ),
      Layer.provideMerge(
        Layer.succeed(
          MinimumLogLevel,
          process.env.DEBUG ? "Debug" : "Info",
        )
      ),
    )
  ),
  Effect.scoped
);

export default await Effect.runPromise(handlerEffect)
`,
              ),
            );

        const mainFile = bundleOutput.files[0];
        const code =
          typeof mainFile.content === "string"
            ? new TextEncoder().encode(mainFile.content)
            : mainFile.content;

        const includeSourceMaps =
          uploadSourceMap && (sourcemap === true || sourcemap === "hidden");

        const extraFiles = bundleOutput.files
          .slice(1)
          .filter(
            (f: Bundle.BundleFile) =>
              includeSourceMaps || !f.path.endsWith(".map"),
          )
          .map((f: Bundle.BundleFile) => ({
            path: f.path,
            content: f.content,
          }));

        // Resolve install versions without running npm so `diff` can compare a
        // stable identity hash. The archive build performs the install.
        const installIdentity = yield* resolvePackageInstallIdentity({
          cwd,
          requested,
        });
        const resolved = installIdentity.resolved;
        const hasInstalledPackages = Object.keys(resolved).length > 0;

        // Identity hash drives change detection in `diff`. With native packages,
        // the installed bytes are not captured by the bundle hash, so fold the
        // resolved versions, package-manager lockfile, and architecture in
        // instead of installing.
        const identityHash = hasInstalledPackages
          ? yield* hashPackageInstallIdentity({
              bundleHash: bundleOutput.hash,
              identity: installIdentity,
              architecture,
            })
          : bundleOutput.hash;

        const buildArchive = Effect.gen(function* () {
          const installedPackageFiles = hasInstalledPackages
            ? yield* installResolvedPackages({ resolved, architecture })
            : [];
          const archiveFiles = [...extraFiles, ...installedPackageFiles];
          const archive = yield* zipCode(
            code,
            archiveFiles.length > 0 ? archiveFiles : undefined,
          );
          // The S3 asset key is content-addressed, so the archive hash must be a
          // true hash of the bytes when native packages are present.
          const archiveHash =
            installedPackageFiles.length > 0
              ? yield* sha256(archive)
              : bundleOutput.hash;
          return { archive, archiveHash };
        });

        return { identityHash, buildArchive };
      });

      const withNodeSourceMaps = (
        env: Record<string, string> | undefined,
        props: FunctionProps,
      ) => {
        const sourcemap = props.build?.output?.sourcemap ?? true;
        const uploadSourceMap = props.uploadSourceMap ?? true;
        const shouldEnableSourceMaps =
          sourcemap === "inline" ||
          (uploadSourceMap && (sourcemap === true || sourcemap === "hidden"));

        if (!shouldEnableSourceMaps) {
          return env;
        }

        const current = env?.NODE_OPTIONS;
        if (current?.split(/\s+/).includes("--enable-source-maps")) {
          return env;
        }

        return {
          ...env,
          NODE_OPTIONS: current
            ? `${current} --enable-source-maps`
            : "--enable-source-maps",
        };
      };

      const retryFunctionMutation = Effect.retry({
        while: (e: any) =>
          e._tag === "ResourceConflictException" ||
          e._tag === "TooManyRequestsException",
        schedule: Schedule.exponential(100).pipe(
          Schedule.both(Schedule.recurs(30)),
        ),
      }) as <A, R, Err>(
        self: Effect.Effect<A, Err, R>,
      ) => Effect.Effect<A, Err, R>;

      const getReservedConcurrentExecutions = Effect.fn(function* (
        functionName: string,
      ) {
        return yield* Lambda.getFunctionConcurrency({
          FunctionName: functionName,
        }).pipe(
          Effect.map((config) => config.ReservedConcurrentExecutions),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const syncReservedConcurrentExecutions = Effect.fn(function* ({
        functionName,
        reservedConcurrentExecutions,
      }: {
        functionName: string;
        reservedConcurrentExecutions: number | undefined;
      }) {
        const current = yield* getReservedConcurrentExecutions(functionName);
        if (current === reservedConcurrentExecutions) {
          return current;
        }

        if (reservedConcurrentExecutions === undefined) {
          yield* Lambda.deleteFunctionConcurrency({
            FunctionName: functionName,
          }).pipe(
            retryFunctionMutation,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          return undefined;
        }

        const updated = yield* Lambda.putFunctionConcurrency({
          FunctionName: functionName,
          ReservedConcurrentExecutions: reservedConcurrentExecutions,
        }).pipe(retryFunctionMutation);
        return (
          updated.ReservedConcurrentExecutions ?? reservedConcurrentExecutions
        );
      });

      const createOrUpdateFunction = Effect.fn(function* ({
        id,
        news,
        roleArn,
        archive,
        hash,
        env,
        functionName,
        preferUpdate,
        session,
      }: {
        id: string;
        news: FunctionProps;
        roleArn: string;
        archive: Uint8Array<ArrayBufferLike>;
        hash: string;
        env: Record<string, string> | undefined;
        functionName: string;
        preferUpdate?: boolean;
        session: { note: (note: string) => Effect.Effect<void> };
      }) {
        yield* Effect.logDebug(`creating function ${id}`);
        const waitStartedAt = Date.now();

        const isRolePropagationError = <
          E extends Lambda.UpdateFunctionCodeError | Lambda.CreateFunctionError,
        >(
          e: E,
        ) =>
          e._tag === "InvalidParameterValueException" &&
          (e.message?.includes("cannot be assumed by Lambda") ||
            (e.message?.includes("KMS key is invalid for CreateGrant") &&
              e.message?.includes("ARN does not refer to a valid principal")));

        const noteRolePropagationWait = () =>
          session.note(
            `Waiting for Lambda execution role to become assumable: ${functionName} (${Math.ceil((Date.now() - waitStartedAt) / 1000)}s)`,
          );

        const tags = yield* createInternalTags(id);

        // Try to use S3 if assets bucket is available, otherwise fall back to inline ZipFile
        const assets = (yield* Effect.serviceOption(Assets)).pipe(
          Option.getOrUndefined,
        );

        const codeLocation = yield* Effect.gen(function* () {
          if (assets) {
            const key = yield* assets.uploadAsset(hash, archive);
            yield* Effect.logDebug(
              `Using S3 for code: s3://${yield* assets.bucketName}/${key}`,
            );
            return {
              S3Bucket: yield* assets.bucketName,
              S3Key: key,
            } as const;
          } else {
            return { ZipFile: archive } as const;
          }
        });
        const runtimeEnv = withNodeSourceMaps(env, news);

        const createFunctionRequest: CreateFunctionRequest = {
          FunctionName: functionName,
          Handler: `index.${news.handler ?? "default"}`,
          Role: roleArn,
          Code: codeLocation,
          Runtime: news.runtime ?? "nodejs22.x",
          Architectures: [news.architecture ?? "x86_64"],
          MemorySize: news.memorySize,
          Environment: runtimeEnv
            ? {
                Variables: {
                  ...runtimeEnv,
                  ...alchemyEnv,
                },
              }
            : undefined,
          Tags: tags,
          Timeout: toTimeoutSeconds(news.timeout),
          VpcConfig: news.vpc
            ? {
                SubnetIds: news.vpc.subnetIds,
                SecurityGroupIds: news.vpc.securityGroupIds,
              }
            : undefined,
        };

        const getAndUpdate = Lambda.getFunction({
          FunctionName: functionName,
        }).pipe(
          Effect.filterOrFail(
            // if it exists and contains these tags, we will assume it was created by alchemy
            // but state was lost, so if it exists, let's adopt it
            (f) => hasTags(tags, f.Tags),
            () =>
              // TODO(sam): add custom
              new Error("Function tags do not match expected values"),
          ),
          Effect.flatMap(() =>
            Effect.gen(function* () {
              yield* Effect.logDebug(`updating function code ${id}`);
              yield* Lambda.updateFunctionCode({
                FunctionName: createFunctionRequest.FunctionName,
                Architectures: createFunctionRequest.Architectures,
                // Use S3 or ZipFile based on what was used for create
                ...("S3Bucket" in codeLocation
                  ? {
                      S3Bucket: codeLocation.S3Bucket,
                      S3Key: codeLocation.S3Key,
                    }
                  : { ZipFile: codeLocation.ZipFile }),
              }).pipe(
                Effect.tapError((e) =>
                  isRolePropagationError(e)
                    ? noteRolePropagationWait()
                    : Effect.void,
                ),
                Effect.retry({
                  while: (e) =>
                    e._tag === "ResourceConflictException" ||
                    isRolePropagationError(e),
                  schedule: Schedule.exponential(100),
                }),
              );
              yield* Effect.logDebug(`updated function code ${id}`);
              yield* Lambda.updateFunctionConfiguration({
                FunctionName: createFunctionRequest.FunctionName,
                DeadLetterConfig: createFunctionRequest.DeadLetterConfig,
                Description: createFunctionRequest.Description,
                Environment: createFunctionRequest.Environment,
                EphemeralStorage: createFunctionRequest.EphemeralStorage,
                FileSystemConfigs: createFunctionRequest.FileSystemConfigs,
                Handler: createFunctionRequest.Handler,
                ImageConfig: createFunctionRequest.ImageConfig,
                KMSKeyArn: createFunctionRequest.KMSKeyArn,
                Layers: createFunctionRequest.Layers,
                LoggingConfig: createFunctionRequest.LoggingConfig,
                MemorySize: createFunctionRequest.MemorySize,
                // RevisionId: "???"
                Role: createFunctionRequest.Role,
                Runtime: createFunctionRequest.Runtime,
                SnapStart: createFunctionRequest.SnapStart,
                Timeout: createFunctionRequest.Timeout,
                TracingConfig: createFunctionRequest.TracingConfig,
                VpcConfig: createFunctionRequest.VpcConfig,
              }).pipe(
                Effect.tapError((e) =>
                  isRolePropagationError(e)
                    ? noteRolePropagationWait()
                    : Effect.void,
                ),
                Effect.retry({
                  while: (e) =>
                    e._tag === "ResourceConflictException" ||
                    isRolePropagationError(e),
                  schedule: Schedule.exponential(100),
                }),
              );
              yield* Effect.logDebug(`updated function configuration ${id}`);
            }),
          ),
        );

        const create = Lambda.createFunction(createFunctionRequest).pipe(
          Effect.tapError((e) =>
            Effect.gen(function* () {
              yield* Effect.logDebug(e);
            }),
          ),
          Effect.retry({
            while: (e) => isRolePropagationError(e),
            schedule: Schedule.fixed(1000).pipe(
              Schedule.tapOutput(() => noteRolePropagationWait()),
            ),
          }),
          Effect.catchTags({
            ResourceConflictException: () => getAndUpdate,
          }),
        );

        if (preferUpdate) {
          yield* getAndUpdate.pipe(
            Effect.catchTags({
              ResourceNotFoundException: () => create,
            }),
          );
        } else {
          yield* create;
        }
      });

      const publicUrlAccessStatementId = "FunctionURLAllowPublicAccess";
      const publicUrlInvokeStatementId = "FunctionURLAllowPublicInvoke";

      const removePublicFunctionUrlPermissions = Effect.fn(function* (
        functionName: string,
      ) {
        yield* Effect.all(
          [
            Lambda.removePermission({
              FunctionName: functionName,
              StatementId: publicUrlAccessStatementId,
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
            Lambda.removePermission({
              FunctionName: functionName,
              StatementId: publicUrlInvokeStatementId,
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
          ],
          { concurrency: "unbounded" },
        );
      });

      const upsertPermission = (permission: Lambda.AddPermissionRequest) =>
        Lambda.addPermission(permission).pipe(
          Effect.catchTag("ResourceConflictException", () =>
            Effect.gen(function* () {
              yield* Lambda.removePermission({
                FunctionName: permission.FunctionName,
                StatementId: permission.StatementId,
              }).pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
              yield* Lambda.addPermission(permission);
            }),
          ),
          retryFunctionMutation,
        );

      const upsertPublicFunctionUrlPermissions = Effect.fn(function* (
        functionName: string,
      ) {
        yield* Effect.all(
          [
            upsertPermission({
              FunctionName: functionName,
              StatementId: publicUrlAccessStatementId,
              Action: "lambda:InvokeFunctionUrl",
              Principal: "*",
              FunctionUrlAuthType: "NONE",
            }),
            upsertPermission({
              FunctionName: functionName,
              StatementId: publicUrlInvokeStatementId,
              Action: "lambda:InvokeFunction",
              Principal: "*",
              InvokedViaFunctionUrl: true,
            }),
          ],
          { concurrency: "unbounded" },
        );
      });

      const createOrUpdateFunctionUrl = Effect.fn(function* ({
        functionName,
        url,
        oldUrl,
        currentFunctionUrl,
      }: {
        functionName: string;
        url: FunctionProps["url"];
        oldUrl?: FunctionProps["url"];
        currentFunctionUrl?: string;
      }) {
        const desired = normalizeFunctionUrl(url);
        const previous = normalizeFunctionUrl(oldUrl);
        const hadFunctionUrl = previous !== undefined || !!currentFunctionUrl;

        if (desired) {
          yield* Effect.logDebug(
            `creating function url config ${functionName}`,
          );
          const shouldClearCors =
            desired.cors === undefined && previous?.cors !== undefined;
          const config = {
            FunctionName: functionName,
            AuthType: desired.authType,
            Cors: desired.cors ?? (shouldClearCors ? {} : undefined),
            InvokeMode: desired.invokeMode,
          } satisfies
            | Lambda.CreateFunctionUrlConfigRequest
            | Lambda.UpdateFunctionUrlConfigRequest;
          const { FunctionUrl } = yield* Lambda.createFunctionUrlConfig(
            config,
          ).pipe(
            Effect.catchTag("ResourceConflictException", () =>
              Lambda.updateFunctionUrlConfig(config),
            ),
            retryFunctionMutation,
          );

          if (desired.authType === "NONE") {
            yield* upsertPublicFunctionUrlPermissions(functionName);
          } else {
            yield* removePublicFunctionUrlPermissions(functionName);
          }

          yield* Effect.logDebug(`created function url config ${functionName}`);
          return FunctionUrl;
        } else if (hadFunctionUrl) {
          yield* Effect.logDebug(
            `deleting function url config ${functionName}`,
          );
          yield* Effect.all([
            Lambda.deleteFunctionUrlConfig({
              FunctionName: functionName,
            }).pipe(
              retryFunctionMutation,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
            removePublicFunctionUrlPermissions(functionName),
          ]);
          yield* Effect.logDebug(`deleted function url config ${functionName}`);
        }
        return undefined;
      });

      const summary = ({ archive }: { archive: Uint8Array<ArrayBufferLike> }) =>
        `${
          archive.length >= 1024 * 1024
            ? `${(archive.length / (1024 * 1024)).toFixed(2)}MB`
            : archive.length >= 1024
              ? `${(archive.length / 1024).toFixed(2)}KB`
              : `${archive.length}B`
        }`;

      return {
        stables: ["functionArn", "functionName", "roleName"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return;
          // If output is undefined (resource in creating state), defer to default diff
          if (!output) {
            return undefined;
          }
          if (
            // function name changed
            output.functionName !==
            (yield* createFunctionName(id, news.functionName))
          ) {
            return { action: "replace" };
          }
          if (
            !deepEqual(
              normalizeFunctionUrl(olds.url),
              normalizeFunctionUrl(news.url),
            )
          ) {
            return { action: "update" };
          }
          if (output.code.hash !== (yield* bundleCode(id, news)).identityHash) {
            // code changed
            return { action: "update" };
          }
          if (
            toTimeoutSeconds(olds.timeout) !== toTimeoutSeconds(news.timeout)
          ) {
            return { action: "update" };
          }
          if (
            (olds.architecture ?? "x86_64") !== (news.architecture ?? "x86_64")
          ) {
            return { action: "update" };
          }
          if (
            olds.reservedConcurrentExecutions !==
            news.reservedConcurrentExecutions
          ) {
            return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const functionName =
            output?.functionName ??
            (yield* createFunctionName(id, olds?.functionName));
          yield* Effect.logDebug(`reading function ${functionName}`);
          const fn = yield* Lambda.getFunction({
            FunctionName: functionName,
          }).pipe(
            Effect.map((r) => r.Configuration),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          if (!fn?.FunctionArn || !fn.FunctionName || !fn.Role) {
            return undefined;
          }
          const tagsResult = yield* Lambda.listTags({
            Resource: fn.FunctionArn,
          }).pipe(
            Effect.map((r) => r.Tags ?? {}),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({} as Record<string, string>),
            ),
          );
          const functionUrl = yield* Lambda.getFunctionUrlConfig({
            FunctionName: fn.FunctionName,
          }).pipe(
            Effect.map((f) => f.FunctionUrl),
            Effect.retry({
              while: (e: any) => e._tag === "ResourceConflictException",
              schedule: Schedule.exponential(100),
            }),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          const reservedConcurrentExecutions =
            yield* getReservedConcurrentExecutions(fn.FunctionName);
          // Reuse the persisted output where we have it (e.g. code hash) so
          // diff doesn't see drift it can't reconstruct from the API.
          const attrs = {
            ...output,
            functionArn: fn.FunctionArn,
            functionName: fn.FunctionName,
            functionUrl,
            roleArn: fn.Role,
            roleName: output?.roleName ?? fn.Role.split("/").pop()!,
            reservedConcurrentExecutions,
          } as any;
          return (yield* hasAlchemyTags(id, tagsResult))
            ? attrs
            : Unowned(attrs);
        }),
        // Account/region collection: exhaustively paginate `listFunctions`
        // (its `Functions` items are `FunctionConfiguration`s, the same shape
        // `read` pulls from `getFunction().Configuration`), then hydrate each
        // into the exact `read` Attributes shape with a bounded fan-out. The
        // code hash is not recoverable from the API (it lives in persisted
        // state), so it is left empty — `delete`/nuke only needs the
        // function/role identifiers.
        list: () =>
          Effect.gen(function* () {
            const configs = yield* Lambda.listFunctions.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const rows = yield* Effect.forEach(
              configs,
              (fn) =>
                Effect.gen(function* () {
                  if (!fn.FunctionArn || !fn.FunctionName || !fn.Role) {
                    return undefined;
                  }
                  const functionUrl = yield* Lambda.getFunctionUrlConfig({
                    FunctionName: fn.FunctionName,
                  }).pipe(
                    Effect.map((f) => f.FunctionUrl),
                    // No URL config (or the function vanished between the
                    // list and the hydrate) — surface `undefined`, matching
                    // `read`.
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  );
                  const reservedConcurrentExecutions =
                    yield* getReservedConcurrentExecutions(fn.FunctionName);
                  return {
                    functionArn: fn.FunctionArn,
                    functionName: fn.FunctionName,
                    functionUrl,
                    roleArn: fn.Role,
                    roleName: fn.Role.split("/").pop()!,
                    code: { hash: "" },
                    ...(reservedConcurrentExecutions === undefined
                      ? {}
                      : { reservedConcurrentExecutions }),
                  } satisfies Function["Attributes"];
                }),
              { concurrency: 10 },
            );
            return rows.filter(
              (row): row is Function["Attributes"] => row !== undefined,
            );
          }),

        precreate: Effect.fn(function* ({ id, news, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const { roleName, functionName, roleArn } = yield* createNames(
            id,
            news.functionName,
          );

          const role = yield* createRoleIfNotExists({
            id,
            roleName,
            vpc: news.vpc,
          });

          // Mock code for the pre-created stub. It responds 503 (rather than a
          // bare 200) so that, during the brief window where the real
          // code/config update is still `InProgress`, a Function URL hit serves
          // an honest "not ready" signal instead of a successful-but-empty 200.
          // Downstream readiness probes already retry on non-200, so they wait
          // for the real handler to go live without the provider blocking.
          const code = new TextEncoder().encode(
            `export default () => ({ statusCode: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "function initializing" }) })`,
          );
          const archive = yield* zipCode(code);
          const hash = yield* hashBundle(code);
          yield* createOrUpdateFunction({
            id,
            news,
            roleArn: role.Role.Arn,
            archive,
            hash,
            functionName,
            env: alchemyEnv,
            session,
          });

          return {
            functionArn: `arn:aws:lambda:${region}:${accountId}:function:${functionName}`,
            functionName,
            functionUrl: undefined,
            roleName,
            code: {
              hash,
            },
            roleArn,
          };
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          olds,
          bindings,
          output,
          session,
        }) {
          const { roleName, policyName, functionName, functionArn } =
            yield* createNames(id, news.functionName);

          const roleArn =
            output?.roleArn ??
            (yield* createRoleIfNotExists({ id, roleName, vpc: news.vpc })).Role
              .Arn;

          const env = yield* attachBindings({
            roleName,
            policyName,
            functionArn,
            functionName,
            bindings,
          });

          const { identityHash, buildArchive } = yield* bundleCode(id, news);
          const { archive, archiveHash } = yield* buildArchive;

          yield* createOrUpdateFunction({
            id,
            news,
            roleArn,
            archive,
            hash: archiveHash,
            env: {
              ...env,
              ...news.env,
            },
            functionName,
            preferUpdate: output !== undefined,
            session,
          });

          const reservedConcurrentExecutions =
            yield* syncReservedConcurrentExecutions({
              functionName,
              reservedConcurrentExecutions: news.reservedConcurrentExecutions,
            });

          const functionUrl = yield* createOrUpdateFunctionUrl({
            functionName,
            url: news.url,
            oldUrl: olds?.url,
            currentFunctionUrl: output?.functionUrl,
          });

          yield* session.note(summary({ archive }));

          return {
            ...output,
            functionArn,
            functionName,
            functionUrl: functionUrl as any,
            roleName,
            roleArn,
            code: {
              hash: identityHash,
            },
            reservedConcurrentExecutions,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* iam
            .listRolePolicies({
              RoleName: output.roleName,
            })
            .pipe(
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.PolicyNames ?? []).map((policyName) =>
                    iam.deleteRolePolicy({
                      RoleName: output.roleName,
                      PolicyName: policyName,
                    }),
                  ),
                ),
              ),
            );

          yield* iam
            .listAttachedRolePolicies({
              RoleName: output.roleName,
            })
            .pipe(
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.AttachedPolicies ?? []).map((policy) =>
                    iam
                      .detachRolePolicy({
                        RoleName: output.roleName,
                        PolicyArn: policy.PolicyArn!,
                      })
                      .pipe(
                        Effect.catchTag(
                          "NoSuchEntityException",
                          () => Effect.void,
                        ),
                      ),
                  ),
                ),
              ),
            );

          yield* Lambda.deleteFunction({
            FunctionName: output.functionName,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

          yield* iam
            .deleteRole({
              RoleName: output.roleName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
          return null as any;
        }),
        tail: ({ output }) => {
          const runTailSession = Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;

            const logGroupArn = `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${output.functionName}`;
            const response = yield* logs.startLiveTail({
              logGroupIdentifiers: [logGroupArn],
            });

            if (!response.responseStream) {
              return Stream.empty as Stream.Stream<LogLine>;
            }

            return response.responseStream.pipe(
              Stream.flatMap((event) => {
                if ("sessionUpdate" in event && event.sessionUpdate) {
                  const lines: LogLine[] = (
                    event.sessionUpdate.sessionResults ?? []
                  ).flatMap((result) => {
                    if (!result.message) return [];
                    return [
                      {
                        timestamp: new Date(result.timestamp ?? Date.now()),
                        message: result.message.trimEnd(),
                      },
                    ];
                  });
                  return Stream.fromIterable(lines);
                }
                return Stream.empty;
              }),
            );
          });

          return Stream.unwrap(runTailSession).pipe(
            Stream.retry(Schedule.spaced("1 second")),
          );
        },
        logs: ({
          output,
          options,
        }: {
          output: Function["Attributes"];
          options: LogsInput;
        }) =>
          logs
            .filterLogEvents({
              logGroupName: `/aws/lambda/${output.functionName}`,
              startTime: options.since?.getTime(),
              limit: options.limit ?? 100,
            })
            .pipe(
              Effect.map((response) =>
                (response.events ?? []).flatMap((event): LogLine[] => {
                  if (!event.message) return [];
                  return [
                    {
                      timestamp: new Date(event.timestamp ?? Date.now()),
                      message: event.message.trimEnd(),
                    },
                  ];
                }),
              ),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed([] as LogLine[]),
              ),
            ),
      };
    }),
  );
