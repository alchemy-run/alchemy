import crypto from "node:crypto";
import path from "node:path";

import { FileSystem } from "@effect/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as iam from "distilled-aws/iam";
import type {
  CreateFunctionRequest,
  CreateFunctionUrlConfigRequest,
  UpdateFunctionUrlConfigRequest,
} from "distilled-aws/lambda";
import * as lambda from "distilled-aws/lambda";
import { Region } from "distilled-aws/Region";
import { App } from "../../app.ts";
import { DotAlchemy } from "../../dot-alchemy.ts";
import { createPhysicalName } from "../../physical-name.ts";
import { createInternalTags, createTagsList, hasTags } from "../../tags.ts";
import { Account } from "../account.ts";
import { Assets } from "../assets.ts";
import * as IAM from "../iam/index.ts";
import { zipCode } from "../zip.ts";
import { Function, type FunctionAttr, type FunctionProps } from "./function.ts";

export const functionProvider = () =>
  Function.provider.effect(
    Effect.gen(function* () {
      const app = yield* App;
      const accountId = yield* Account;
      const region = yield* Region;
      const dotAlchemy = yield* DotAlchemy;
      const fs = yield* FileSystem.FileSystem;

      // const assets = yield* Assets;

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
        bindings: Function["binding"][];
      }) {
        const env = bindings
          .map((binding) => binding?.env)
          .reduce((acc, env) => ({ ...acc, ...env }), {});
        const policyStatements = bindings.flatMap(
          (binding) =>
            binding?.policyStatements?.map((stmt: IAM.PolicyStatement) => ({
              ...stmt,
              Sid: stmt.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
            })) ?? [],
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

      const bundleCode = Effect.fn(function* (
        id: string,
        props: {
          main: string;
          handler?: string;
        },
      ) {
        const handler = props.handler ?? "default";
        let file = path.relative(process.cwd(), props.main);
        if (!file.startsWith(".")) {
          file = `./${file}`;
        }
        const { bundle } = yield* Effect.promise(() => import("../bundle.ts"));
        const outfile = path.join(
          dotAlchemy,
          "out",
          `${app.name}-${app.stage}-${id}.ts`,
        );
        yield* bundle({
          // entryPoints: [props.main],
          // we use a virtual entry point so that we can pluck out the user's handler closure and only its dependencies (not the whole module)
          stdin: {
            contents: `import { ${handler} as handler } from "${file}";\nexport default handler;`,
            resolveDir: process.cwd(),
            loader: "ts",
            sourcefile: "__index.ts",
          },
          bundle: true,
          format: "esm",
          platform: "node",
          target: "node22",
          sourcemap: true,
          treeShaking: true,
          write: true,
          outfile,
          minify: true,
          external: ["@aws-sdk/*", "@smithy/*"],
          logLevel: "error",
        });
        const code = yield* fs
          .readFile(outfile)
          .pipe(Effect.catchAll(Effect.die));
        return {
          code,
          hash: yield* hashCode(code),
        };
      });

      const hashCode = (code: string | Uint8Array<ArrayBufferLike>) =>
        Effect.sync(() =>
          crypto.createHash("sha256").update(code).digest("hex"),
        );

      const createOrUpdateFunction = Effect.fn(function* ({
        id,
        news,
        roleArn,
        code,
        hash,
        env,
        functionName,
      }: {
        id: string;
        news: FunctionProps<any>;
        roleArn: string;
        code: Uint8Array<ArrayBufferLike>;
        hash: string;
        env: Record<string, string> | undefined;
        functionName: string;
      }) {
        yield* Effect.logDebug(`creating function ${id}`);

        const tags = yield* createInternalTags(id);

        // Try to use S3 if assets bucket is available, otherwise fall back to inline ZipFile
        const assets = yield* Effect.serviceOption(Assets);
        const codeLocation = yield* Option.match(assets, {
          onNone: () =>
            Effect.gen(function* () {
              const zipped = yield* zipCode(code);
              return { ZipFile: zipped } as const;
            }),
          onSome: (assetsService) =>
            Effect.gen(function* () {
              const key = yield* assetsService.uploadAsset(
                hash,
                yield* zipCode(code),
              );
              yield* Effect.logDebug(
                `Using S3 for code: s3://${assetsService.bucketName}/${key}`,
              );
              return {
                S3Bucket: assetsService.bucketName,
                S3Key: key,
              } as const;
            }),
        });

        const createFunctionRequest: CreateFunctionRequest = {
          FunctionName: functionName,
          Handler: `index.${news.handler ?? "default"}`,
          Role: roleArn,
          Code: codeLocation,
          Runtime: news.runtime ?? "nodejs22.x",
          Environment: env
            ? {
                Variables: env,
              }
            : undefined,
          Tags: tags,
        };

        const getAndUpdate = lambda
          .getFunction({
            FunctionName: functionName,
          })
          .pipe(
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
                yield* lambda
                  .updateFunctionCode({
                    FunctionName: createFunctionRequest.FunctionName,
                    Architectures: createFunctionRequest.Architectures,
                    // Use S3 or ZipFile based on what was used for create
                    ...("S3Bucket" in codeLocation
                      ? {
                          S3Bucket: codeLocation.S3Bucket,
                          S3Key: codeLocation.S3Key,
                        }
                      : { ZipFile: codeLocation.ZipFile }),
                  })
                  .pipe(
                    Effect.retry({
                      while: (e) =>
                        e._tag === "ResourceConflictException" ||
                        (e._tag === "InvalidParameterValueException" &&
                          e.message?.includes(
                            "The role defined for the function cannot be assumed by Lambda.",
                          )),
                      schedule: Schedule.exponential(100),
                    }),
                  );
                yield* Effect.logDebug(`updated function code ${id}`);
                yield* lambda
                  .updateFunctionConfiguration({
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
                  })
                  .pipe(
                    Effect.retry({
                      while: (e) =>
                        e._tag === "ResourceConflictException" ||
                        (e._tag === "InvalidParameterValueException" &&
                          e.message?.includes(
                            "The role defined for the function cannot be assumed by Lambda.",
                          )),
                      schedule: Schedule.exponential(100),
                    }),
                  );
                yield* Effect.logDebug(`updated function configuration ${id}`);
              }),
            ),
          );

        yield* lambda.createFunction(createFunctionRequest).pipe(
          Effect.tapError(Effect.logDebug),
          Effect.retry({
            while: (e) =>
              e._tag === "InvalidParameterValueException" &&
              e.message?.includes("cannot be assumed by Lambda"),
            schedule: Schedule.exponential(10),
          }),
          Effect.catchTags({
            ResourceConflictException: () => getAndUpdate,
          }),
        );
      });

      const createOrUpdateFunctionUrl = Effect.fn(function* ({
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
            | CreateFunctionUrlConfigRequest
            | UpdateFunctionUrlConfigRequest;
          const permission = {
            FunctionName: functionName,
            StatementId: "FunctionURLAllowPublicAccess",
            Action: "lambda:InvokeFunctionUrl",
            Principal: "*",
            FunctionUrlAuthType: "NONE",
          } as const;
          const [{ FunctionUrl }] = yield* Effect.all([
            lambda
              .createFunctionUrlConfig(config)
              .pipe(
                Effect.catchTag("ResourceConflictException", () =>
                  lambda.updateFunctionUrlConfig(config),
                ),
              ),
            authType === "NONE"
              ? lambda.addPermission(permission).pipe(
                  Effect.catchTag("ResourceConflictException", () =>
                    Effect.gen(function* () {
                      yield* lambda.removePermission({
                        FunctionName: functionName,
                        StatementId: "FunctionURLAllowPublicAccess",
                      });
                      yield* lambda.addPermission(permission);
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
            lambda
              .deleteFunctionUrlConfig({
                FunctionName: functionName,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
            lambda
              .removePermission({
                FunctionName: functionName,
                StatementId: "FunctionURLAllowPublicAccess",
              })
              .pipe(
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
        diff: Effect.fn(function* ({ id, olds, news, output }) {
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
            })).hash
          ) {
            // code changed
            return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ id, output }) {
          if (output) {
            yield* Effect.logDebug(`reading function ${id}`);
            // example: refresh the function URL from the API
            return {
              ...output,
              functionUrl: (yield* lambda
                .getFunctionUrlConfig({
                  FunctionName: yield* createFunctionName(
                    id,
                    output.functionName,
                  ),
                })
                .pipe(
                  Effect.map((f) => f.FunctionUrl),
                  Effect.retry({
                    //   error: ResourceConflictException: The operation cannot be performed at this time.
                    // An update is in progress for resource: arn:aws:lambda:us-west-2:084828582823:function:my-app-dev-Consumer-us-west-2
                    while: (e) => e.name === "ResourceConflictException",
                    schedule: Schedule.exponential(100),
                  }),
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )) as any,
            } satisfies FunctionAttr<FunctionProps>;
          }
          return output;
        }),

        precreate: Effect.fn(function* ({ id, news }) {
          const { roleName, functionName, roleArn } = yield* createNames(
            id,
            news.functionName,
          );

          const role = yield* createRoleIfNotExists({ id, roleName });

          // mock code
          const code = new TextEncoder().encode("export default () => {}");
          const hash = yield* hashCode(code);
          yield* createOrUpdateFunction({
            id,
            news,
            roleArn: role.Role.Arn,
            code,
            hash,
            functionName,
            env: {},
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
          } satisfies FunctionAttr<FunctionProps>;
        }),
        create: Effect.fn(function* ({ id, news, bindings, session }) {
          const { roleName, policyName, functionName, functionArn } =
            yield* createNames(id, news.functionName);

          const role = yield* createRoleIfNotExists({ id, roleName });

          const env = yield* attachBindings({
            roleName,
            policyName,
            functionArn,
            functionName,
            bindings,
          });

          const { code, hash } = yield* bundleCode(id, news);

          yield* createOrUpdateFunction({
            id,
            news,
            roleArn: role.Role.Arn,
            code,
            hash,
            env,
            functionName,
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
            roleArn: role.Role.Arn,
            code: {
              hash,
            },
          } satisfies FunctionAttr<FunctionProps>;
        }),
        update: Effect.fn(function* ({
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

          const { code, hash } = yield* bundleCode(id, news);

          yield* createOrUpdateFunction({
            id,
            news,
            roleArn: output.roleArn,
            code,
            hash,
            env,
            functionName,
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
          } satisfies FunctionAttr<FunctionProps>;
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

          yield* lambda
            .deleteFunction({
              FunctionName: output.functionName,
            })
            .pipe(
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
