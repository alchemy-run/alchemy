import { FileSystem } from "@effect/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import crypto from "node:crypto";
import path from "node:path";

import {
  App,
  DotAlchemy,
  type Binder,
  type BindNode,
  type Provider,
  type Statement,
} from "@alchemy.run/effect";
import type {
  CreateFunctionUrlConfigRequest,
  UpdateFunctionUrlConfigRequest,
} from "itty-aws/lambda";
import { AccountID } from "../account.ts";
import * as IAM from "../iam.ts";
import { Region } from "../region.ts";
import { zipCode } from "../zip.ts";
import { FunctionClient } from "./function.client.ts";
import {
  FunctionType,
  type FunctionAttributes,
  type FunctionProps,
} from "./function.ts";

export interface FunctionProviderProps extends FunctionProps {
  /**
   * The main file to use for the function.
   */
  main: string;
  /**
   * The handler to use for the function.
   * @default "default"
   */
  handler?: string;
}

export class FunctionProvider extends Context.Tag("AWS::Lambda::Function")<
  FunctionProvider,
  Provider<
    FunctionType,
    FunctionProviderProps,
    FunctionAttributes<string, FunctionProps>,
    Statement
  >
>() {}

export const functionProvider = () =>
  Layer.effect(
    FunctionProvider,
    Effect.gen(function* () {
      const lambda = yield* FunctionClient;
      const iam = yield* IAM.IAMClient;
      const accountId = yield* AccountID;
      const region = yield* Region;
      const app = yield* App;
      const dotAlchemy = yield* DotAlchemy;
      const fs = yield* FileSystem.FileSystem;

      // const assets = yield* Assets;

      const createFunctionName = (id: string) =>
        `${app.name}-${app.stage}-${id}-${region}`;
      const createRoleName = (id: string) =>
        `${app.name}-${app.stage}-${id}-${region}`;
      const createPolicyName = (id: string) =>
        `${app.name}-${app.stage}-${id}-${region}`;

      const attachBindings = Effect.fn(function* ({
        roleName,
        policyName,
        functionArn,
        functionName,
        bindings,
      }: {
        roleName: string;
        policyName: string;
        functionArn: string;
        functionName: string;
        bindings: BindNode[];
      }) {
        let env: Record<string, string> = {};
        const policyStatements: IAM.PolicyStatement[] = [];

        for (const binding of bindings) {
          if (binding.action === "attach") {
            const binder = yield* binding.stmt.binder as Context.Tag<
              never,
              Binder
            >;
            const bound = yield* binder.attach({
              host: {
                functionArn,
                functionName,
                env,
                policyStatements,
              },
              binding,
              resource: binding.attributes,
            });
            env = { ...env, ...(bound?.env ?? {}) };
            policyStatements.push(...(bound?.policyStatements ?? []));
          } else if (binding.action === "detach") {
            // no-op: PutRolePolicy will remove the removed statements
          }
        }

        yield* iam.putRolePolicy({
          RoleName: roleName,
          PolicyName: policyName,
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: policyStatements,
          } satisfies IAM.PolicyDocument),
        });

        return env;
      });

      const createRole = Effect.fn(function* ({
        id,
        roleName,
      }: {
        id: string;
        roleName: string;
      }) {
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
            Tags: createTagsList(id),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam
                .getRole({
                  RoleName: roleName,
                })
                .pipe(
                  Effect.filterOrFail(
                    (role) => validateTagList(tagged(id), role.Role?.Tags),
                    () =>
                      new Error(
                        `Role ${roleName} exists but has incorrect tags`,
                      ),
                  ),
                ),
            ),
          );

        yield* iam.attachRolePolicy({
          RoleName: roleName,
          PolicyArn:
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        });

        return role;
      });

      const bundleCode = Effect.fn(function* (
        id: string,
        props: FunctionProviderProps,
      ) {
        const handler = props.handler ?? "default";
        let file = path.relative(process.cwd(), props.main);
        if (!file.startsWith(".")) {
          file = `./${file}`;
        }
        const { bundle } = yield* Effect.promise(() => import("../bundle.js"));
        const outfile = path.join(
          dotAlchemy,
          "out",
          `${app.name}-${app.stage}-${id}.js`,
        );
        yield* bundle({
          // entryPoints: [props.main],
          // we use a virtual entry point so that
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
        });
        const code = yield* fs
          .readFile(outfile)
          .pipe(Effect.catchAll(Effect.die));
        return {
          code,
          hash: yield* hashCode(code),
        };
      });

      const hashCode = (code: Uint8Array<ArrayBufferLike>) =>
        Effect.sync(() =>
          crypto.createHash("sha256").update(code).digest("hex"),
        );

      const validateTagList = (
        expectedTags: Record<string, string>,
        tags: { Key: string; Value: string }[] | undefined,
      ) => {
        return Object.entries(expectedTags).every(([key, value]) =>
          tags?.some((tag) => tag.Key === key && tag.Value === value),
        );
      };

      const validateTags = (
        expectedTags: Record<string, string>,
        tags: Record<string, string> | undefined,
      ) => {
        return Object.entries(expectedTags).every(
          ([key, value]) => tags?.[key] === value,
        );
      };

      const createTagsList = (id: string) =>
        Object.entries(tagged(id)).map(([Key, Value]) => ({
          Key,
          Value,
        }));

      const tagged = (id: string) => ({
        "alchemy::app": app.name,
        "alchemy::stage": app.stage,
        "alchemy::id": id,
      });

      const createOrUpdateFunction = Effect.fn(function* ({
        id,
        news,
        roleArn,
        code,
        env,
        functionName,
      }: {
        id: string;
        news: FunctionProviderProps;
        roleArn: string;
        code: Uint8Array<ArrayBufferLike>;
        env: Record<string, string>;
        functionName: string;
      }) {
        yield* lambda
          .createFunction({
            FunctionName: functionName,
            Handler: `index.${news.handler ?? "default"}`,
            Role: roleArn,
            Code: {
              // TODO(sam): upload to assets
              ZipFile: yield* zipCode(code),
            },
            Runtime: "nodejs22.x",
            Environment: {
              Variables: env,
            },
            Tags: tagged(id),
          })
          .pipe(
            Effect.retry({
              while: (e) =>
                e.name === "InvalidParameterValueException" &&
                e.message?.includes("cannot be assumed by Lambda"),
              schedule: Schedule.exponential(10),
            }),
            Effect.catchTag("ResourceConflictException", () =>
              lambda
                .getFunction({
                  FunctionName: functionName,
                })
                .pipe(
                  Effect.flatMap((f) =>
                    // if it exists and contains these tags, we will assume it was created by alchemy
                    // but state was lost, so if it exists, let's adopt it
                    validateTags(tagged(id), f.Tags)
                      ? Effect.succeed(f.Configuration!)
                      : Effect.fail(
                          new Error(
                            "Function tags do not match expected values",
                          ),
                        ),
                  ),
                ),
            ),
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
          const [{ FunctionUrl }] = yield* Effect.all([
            lambda
              .createFunctionUrlConfig(config)
              .pipe(
                Effect.catchTag("ResourceConflictException", () =>
                  lambda.updateFunctionUrlConfig(config),
                ),
              ),
            authType === "NONE"
              ? lambda.addPermission({
                  FunctionName: functionName,
                  StatementId: "FunctionURLAllowPublicAccess",
                  Action: "lambda:InvokeFunctionUrl",
                  Principal: "*",
                  FunctionUrlAuthType: "NONE",
                })
              : Effect.void,
          ]);
          return FunctionUrl;
        } else if (oldUrl) {
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
        type: FunctionType,
        read: Effect.fn(function* ({ id, output }) {
          if (output) {
            // example: refresh the function URL from the API
            return {
              ...output,
              functionUrl: yield* lambda
                .getFunctionUrlConfig({
                  FunctionName: createFunctionName(id),
                })
                .pipe(
                  Effect.map((f) => f.FunctionUrl),
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
            } satisfies FunctionAttributes<string, FunctionProps>;
          }
          return output;
        }),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (
            output.functionName !==
            (news.functionName ?? createFunctionName(id))
          ) {
            // function name changed
            return { action: "replace" };
          }
          if (olds.url !== news.url) {
            // url changed
            return { action: "replace" };
          }
          const { hash } = yield* bundleCode(id, news);
          if (output.code.hash !== hash) {
            // code changed
            return { action: "update" };
          }
          return { action: "noop" };
        }),
        create: Effect.fn(function* ({ id, news, bindings, session }) {
          const roleName = createRoleName(id);
          const policyName = createPolicyName(id);
          // const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;
          const functionName = news.functionName ?? createFunctionName(id);
          const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`;

          const role = yield* createRole({ id, roleName });

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
            // TODO(sam): upload to assets
            code,
            env,
            functionName,
          });

          const functionUrl = yield* createOrUpdateFunctionUrl({
            functionName,
            url: news.url,
          });

          yield* session.note(summary({ code }));

          return {
            id,
            type: "AWS::Lambda::Function",
            functionArn,
            functionName,
            functionUrl: functionUrl as any,
            roleName,
            roleArn: role.Role.Arn,
            code: {
              hash,
            },
          } satisfies FunctionAttributes<string, FunctionProps>;
        }),
        update: Effect.fn(function* ({
          id,
          news,
          olds,
          bindings,
          output,
          session,
        }) {
          const roleName = createRoleName(id);
          const policyName = createPolicyName(id);
          const functionName = news.functionName ?? createFunctionName(id);
          const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`;

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
            // TODO(sam): upload to assets
            code,
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
          } satisfies FunctionAttributes<string, FunctionProps>;
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
      } satisfies Provider<
        FunctionType,
        FunctionProviderProps,
        FunctionAttributes<string, FunctionProps>
      >;
    }),
  );
