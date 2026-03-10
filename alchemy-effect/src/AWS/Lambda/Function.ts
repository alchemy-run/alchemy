import type * as lambda from "aws-lambda";
import type { Credentials } from "distilled-aws/Credentials";
import * as iam from "distilled-aws/iam";
import type { CreateFunctionRequest } from "distilled-aws/lambda";
import * as Lambda from "distilled-aws/lambda";
import { Region } from "distilled-aws/Region";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as ServiceMap from "effect/ServiceMap";
import { Bundler, type BundleOptions } from "../../Bundle/Bundler.ts";
import { DotAlchemy } from "../../Config.ts";
import {
  Host,
  type ListenHandler,
  type ServerlessExecutionContext,
} from "../../Host.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { createInternalTags, createTagsList, hasTags } from "../../Tags.ts";
import { sha256 } from "../../Util/sha256.ts";
import { zipCode } from "../../Util/zip.ts";
import { Account } from "../Account.ts";
import { Assets } from "../Assets.ts";
import * as IAM from "../IAM/index.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";

export class HandlerContext extends ServiceMap.Service<
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

export interface FunctionProps {
  main: string;
  handler?: string;
  url?: boolean;
  functionName?: string;
  // TODO(sam): use a Layer instead so we can manage Effect platform?
  runtime?: "nodejs22.x" | "nodejs24.x";
  build?: Partial<BundleOptions>;
  uploadSourceMap?: boolean;
  env?: Record<string, any>;
  exports?: string[];
}

export interface Function extends Resource<
  "AWS.Lambda.Function",
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
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  }
> {}

export const Function = Host<
  Function,
  ServerlessExecutionContext,
  Credentials | Region
>("AWS.Lambda.Function", (id: string) => {
  const listeners: Effect.Effect<ListenHandler>[] = [];
  const env: Record<string, any> = {};

  return {
    type: "AWS.Lambda.Function",
    run: undefined!,
    id,
    env,
    set: (id: string, output: Output.Output) =>
      Effect.sync(() => {
        const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
        env[key] = output.pipe(Output.map((value) => JSON.stringify(value)));
        return key;
      }),
    get: <T>(key: string) =>
      Config.string(key)
        .asEffect()
        .pipe(
          Effect.flatMap((val) =>
            Effect.try({
              try: () => JSON.parse(val) as T,
              catch: (error) => error as Error,
            }),
          ),
          Effect.catch((cause) =>
            Effect.die(
              new Error(`Failed to get environment variable: ${key}`, {
                cause,
              }),
            ),
          ),
        ),
    listen: ((handler: ListenHandler | Effect.Effect<ListenHandler>) =>
      Effect.sync(() =>
        Effect.isEffect(handler)
          ? listeners.push(handler)
          : listeners.push(Effect.succeed(handler)),
      )) as any as ServerlessExecutionContext["listen"],
    exports: {
      // construct an Effect that produces the Function's entrypoint
      // Effect<(event, context) => Promise<any>>
      handler: Effect.map(
        Effect.all(listeners, {
          concurrency: "unbounded",
        }),
        (handlers) =>
          (event: any, context: lambda.Context): Promise<any> => {
            for (const handler of handlers) {
              const eff = handler(event);
              if (Effect.isEffect(eff)) {
                return eff.pipe(
                  Effect.provideService(HandlerContext, context),
                  Effect.tap(Effect.logDebug),
                  Effect.runPromise,
                );
              }
            }
            throw new Error("No event handler found");
          },
      ),
    },
  } satisfies ServerlessExecutionContext;
});

export const FunctionProvider = () =>
  Function.provider.effect(
    Effect.gen(function* () {
      const stack = yield* Stack;
      const stage = yield* Stage;
      const accountId = yield* Account;
      const region = yield* Region;
      const dotAlchemy = yield* DotAlchemy;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bundler = yield* Bundler;
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

      const hashBundle = Effect.fnUntraced(function* (
        code: Uint8Array<ArrayBufferLike>,
        sourceMap?: Uint8Array<ArrayBufferLike>,
      ) {
        const codeHash = yield* sha256(code);
        const sourceMapHash = sourceMap ? yield* sha256(sourceMap) : "";
        return yield* sha256(JSON.stringify({ codeHash, sourceMapHash }));
      });

      const createNames = (id: string, functionName: string | undefined) =>
        Effect.gen(function* () {
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

      const attachBindings = Effect.fnUntraced(function* ({
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
          (binding: ResourceBinding<Function["Binding"]> & { action?: string }) =>
            binding.action !== "delete",
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

      const createRoleIfNotExists = Effect.fnUntraced(function* ({
        id,
        roleName,
      }: {
        id: string;
        roleName: string;
      }) {
        yield* Effect.logDebug(`creating role ${id}`);
        const tags = yield* createInternalTags(id);
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
              iam
                .getRole({
                  RoleName: roleName,
                })
                .pipe(
                  Effect.filterOrFail(
                    (role) => hasTags(tags, role.Role?.Tags),
                    () =>
                      new Error(
                        `Role ${roleName} exists but has incorrect tags`,
                      ),
                  ),
                ),
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

        yield* Effect.logDebug(`attached policy ${id}`);
        return role;
      });

      const bundleCode = Effect.fnUntraced(function* (
        id: string,
        props: FunctionProps,
      ) {
        const handler = props.handler ?? "default";
        const outfile = path.join(
          dotAlchemy,
          "out",
          `${stack.name}-${stage}-${id}.js`,
        );
        const tempRoot = path.join(dotAlchemy, "tmp");
        yield* fs.makeDirectory(tempRoot, { recursive: true });
        const tempDir = path.join(tempRoot, `${stack.name}-${stage}-${id}`);
        yield* fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore);
        yield* fs.makeDirectory(tempDir, { recursive: true });

        const [realTempDir, realMain] = yield* Effect.all([
          fs.realPath(tempDir),
          fs.realPath(props.main),
        ]);
        const tempEntry = path.join(realTempDir, "__index.ts");
        let file = path.relative(realTempDir, realMain);
        if (!file.startsWith(".")) {
          file = `./${file}`;
        }
        file = file.replaceAll("\\", "/");
        yield* fs.writeFileString(
          tempEntry,
          `
import { NodeServices } from "@effect/platform-node";
import { Stack } from "alchemy-effect/Stack";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Credentials from "distilled-aws/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "distilled-aws/Region";

import { ${handler} as handler } from "${file}";

const platform = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  // TODO(sam): wire this up to telemetry more directly
  Logger.layer([Logger.consolePretty()]),
);

const handlerEffect = handler.pipe(
  Effect.flatMap(func => func.ExecutionContext.exports.handler),
  Effect.provide(
    Layer.effect(
      Stack,
      Effect.all([
        Config.string("ALCHEMY_STACK_NAME").asEffect(),
        Config.string("ALCHEMY_STAGE").asEffect()
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    ).pipe(
      Layer.provideMerge(Credentials.fromEnv()),
      Layer.provideMerge(Region.fromEnv()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv()
        )
      ),
    )
  ),
  Effect.scoped
);

export default await Effect.runPromise(handlerEffect)
`,
        );

        return yield* Effect.gen(function* () {
          const sourcemap = props.build?.sourcemap ?? true;
          const uploadSourceMap = props.uploadSourceMap ?? true;
          yield* bundler.build({
            ...props.build,
            entry: tempEntry,
            outfile,
            format: "esm",
            platform: "node",
            target: "node22",
            sourcemap,
            treeshake: props.build?.treeshake ?? true,
            minify: props.build?.minify ?? true,
            external: [
              "@aws-sdk/*",
              "@smithy/*",
              ...(props.build?.external ?? []),
            ],
          });
          const code = yield* fs.readFile(outfile).pipe(Effect.orDie);
          const sourceMap =
            uploadSourceMap && (sourcemap === true || sourcemap === "external")
              ? yield* fs
                  .exists(`${outfile}.map`)
                  .pipe(
                    Effect.flatMap((exists) =>
                      exists
                        ? fs.readFile(`${outfile}.map`).pipe(Effect.orDie)
                        : Effect.succeed(undefined),
                    ),
                  )
              : undefined;
          const archive = yield* zipCode(
            code,
            sourceMap
              ? [
                  {
                    path: `${path.basename(outfile)}.map`,
                    content: sourceMap,
                  },
                ]
              : undefined,
          );
          return {
            archive,
            code,
            hash: yield* hashBundle(code, sourceMap),
          };
        }).pipe(
          Effect.ensuring(
            fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore),
          ),
        );
      });

      const withNodeSourceMaps = (
        env: Record<string, string> | undefined,
        props: FunctionProps,
      ) => {
        const sourcemap = props.build?.sourcemap ?? true;
        const uploadSourceMap = props.uploadSourceMap ?? true;
        const shouldEnableSourceMaps =
          sourcemap === "inline" ||
          (uploadSourceMap && (sourcemap === true || sourcemap === "external"));

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

      const createOrUpdateFunction = Effect.fnUntraced(function* ({
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
              `Using S3 for code: s3://${assets.bucketName}/${key}`,
            );
            return {
              S3Bucket: assets.bucketName,
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
          Environment: runtimeEnv
            ? {
                Variables: {
                  ...runtimeEnv,
                  ...alchemyEnv,
                },
              }
            : undefined,
          Tags: tags,
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

      const createOrUpdateFunctionUrl = Effect.fnUntraced(function* ({
        functionName,
        url,
        oldUrl,
      }: {
        functionName: string;
        url: FunctionProps["url"];
        oldUrl?: FunctionProps["url"];
      }) {
        // TODO(sam): support AWS_IAM
        const authType = "NONE";
        yield* Effect.logDebug(`creating function url config ${functionName}`);
        if (url) {
          const config = {
            FunctionName: functionName,
            AuthType: authType, // | AWS_IAM
            // Cors: {
            //   AllowCredentials: true,
            //   AllowHeaders: ["*"],
            //   AllowMethods: ["*"],
            //   AllowOrigins: ["*"],
            //   ExposeHeaders: ["*"],
            //   MaxAge: 86400,
            // },
            InvokeMode: "BUFFERED", // | RESPONSE_STREAM
            // Qualifier: "$LATEST"
          } satisfies
            | Lambda.CreateFunctionUrlConfigRequest
            | Lambda.UpdateFunctionUrlConfigRequest;
          const permission = {
            FunctionName: functionName,
            StatementId: "FunctionURLAllowPublicAccess",
            Action: "lambda:InvokeFunctionUrl",
            Principal: "*",
            FunctionUrlAuthType: "NONE",
          } as const;
          const [{ FunctionUrl }] = yield* Effect.all([
            Lambda.createFunctionUrlConfig(config).pipe(
              Effect.catchTag("ResourceConflictException", () =>
                Lambda.updateFunctionUrlConfig(config),
              ),
            ),
            authType === "NONE"
              ? Lambda.addPermission(permission).pipe(
                  Effect.catchTag("ResourceConflictException", () =>
                    Effect.gen(function* () {
                      yield* Lambda.removePermission({
                        FunctionName: functionName,
                        StatementId: "FunctionURLAllowPublicAccess",
                      });
                      yield* Lambda.addPermission(permission);
                    }),
                  ),
                )
              : Effect.void,
          ]);
          yield* Effect.logDebug(`created function url config ${functionName}`);
          return FunctionUrl;
        } else if (oldUrl) {
          yield* Effect.logDebug(
            `deleting function url config ${functionName}`,
          );
          yield* Effect.all([
            Lambda.deleteFunctionUrlConfig({
              FunctionName: functionName,
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
            Lambda.removePermission({
              FunctionName: functionName,
              StatementId: "FunctionURLAllowPublicAccess",
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
          ]);
          yield* Effect.logDebug(`deleted function url config ${functionName}`);
        }
        return undefined;
      });

      const summary = ({ code }: { code: Uint8Array<ArrayBufferLike> }) =>
        `${
          code.length >= 1024 * 1024
            ? `${(code.length / (1024 * 1024)).toFixed(2)}MB`
            : code.length >= 1024
              ? `${(code.length / 1024).toFixed(2)}KB`
              : `${code.length}B`
        }`;

      return {
        stables: ["functionArn", "functionName", "roleName"],
        diff: Effect.fnUntraced(function* ({ id, olds, news, output }) {
          // If output is undefined (resource in creating state), defer to default diff
          if (!output) {
            return undefined;
          }
          if (
            // function name changed
            output.functionName !==
              (yield* createFunctionName(id, news.functionName)) ||
            // url changed
            olds.url !== news.url
          ) {
            return { action: "replace" };
          }
          if (
            output.code.hash !==
            (yield* bundleCode(id, {
              main: news.main,
              handler: news.handler,
              build: news.build,
              uploadSourceMap: news.uploadSourceMap,
            })).hash
          ) {
            // code changed
            return { action: "update" };
          }
        }),
        read: Effect.fnUntraced(function* ({ id, output }) {
          if (output) {
            yield* Effect.logDebug(`reading function ${id}`);
            // example: refresh the function URL from the API
            return {
              ...output,
              functionUrl: (yield* Lambda.getFunctionUrlConfig({
                FunctionName: yield* createFunctionName(
                  id,
                  output.functionName,
                ),
              }).pipe(
                Effect.map((f) => f.FunctionUrl),
                Effect.retry({
                  // TODO(sam): did we lose this error? Is it missing for a good
                  while: (e: any) => e._tag === "ResourceConflictException",
                  schedule: Schedule.exponential(100),
                }),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              )) as any,
            };
          }
          return output;
        }),

        precreate: Effect.fnUntraced(function* ({ id, news, session }) {
          const { roleName, functionName, roleArn } = yield* createNames(
            id,
            news.functionName,
          );

          const role = yield* createRoleIfNotExists({ id, roleName });

          // mock code
          const code = new TextEncoder().encode("export default () => {}");
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
        create: Effect.fnUntraced(function* ({
          id,
          news,
          bindings,
          output,
          session,
        }) {
          const { roleName, policyName, functionName, functionArn } =
            yield* createNames(id, news.functionName);

          const roleArn =
            output?.roleArn ??
            (yield* createRoleIfNotExists({ id, roleName })).Role.Arn;

          const env = yield* attachBindings({
            roleName,
            policyName,
            functionArn,
            functionName,
            bindings,
          });

          const { archive, code, hash } = yield* bundleCode(id, news);

          yield* createOrUpdateFunction({
            id,
            news,
            roleArn,
            archive,
            hash,
            env: {
              ...env,
              ...news.env,
            },
            functionName,
            preferUpdate: output !== undefined,
            session,
          });

          const functionUrl = yield* createOrUpdateFunctionUrl({
            functionName,
            url: news.url,
          });

          yield* session.note(summary({ code }));

          return {
            functionArn,
            functionName,
            functionUrl: functionUrl as any,
            roleName,
            roleArn,
            code: {
              hash,
            },
          };
        }),
        update: Effect.fnUntraced(function* ({
          id,
          news,
          olds,
          bindings,
          output,
          session,
        }) {
          const { roleName, policyName, functionName, functionArn } =
            yield* createNames(id, news.functionName);

          const env = yield* attachBindings({
            roleName,
            policyName,
            functionArn,
            functionName,
            bindings,
          });

          const { archive, code, hash } = yield* bundleCode(id, news);

          yield* createOrUpdateFunction({
            id,
            news,
            roleArn: output.roleArn,
            archive,
            hash,
            env: {
              ...env,
              ...news.env,
            },
            functionName,
            session,
          });

          const functionUrl = yield* createOrUpdateFunctionUrl({
            functionName,
            url: news.url,
            oldUrl: olds.url,
          });

          yield* session.note(summary({ code }));

          return {
            ...output,
            functionArn,
            functionName,
            functionUrl: functionUrl as any,
            roleName,
            roleArn: output.roleArn,
            code: {
              hash,
            },
          };
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
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
      };
    }),
  );
