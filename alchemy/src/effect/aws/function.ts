import path from "node:path";

import type { HttpServerRequest } from "@effect/platform/HttpServerRequest";
import type { HttpServerResponse } from "@effect/platform/HttpServerResponse";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Lambda as LambdaClient } from "itty-aws/lambda";
import { App } from "../app.ts";
import type { Bound } from "../binding.ts";
import { allow, type Allow, type Policy, type Statement } from "../policy.ts";
import type { Provider as ResourceProvider } from "../provider.ts";
import type { Resource } from "../resource.ts";
import type { Tag as ArnTag } from "./arn.ts";
import { Assets } from "./assets.ts";
import { bundle } from "./bundle.ts";
import { createAWSServiceClientLayer } from "./client.ts";
import * as IAM from "./iam.ts";
import { Region } from "./region.ts";

type Props = {
  url?: boolean;
  functionName?: string;
  /**
   * The `main` module of the function (to be bundled and deployed)
   */
  main: string;
  /**
   * @default "default"
   */
  handler?: string;
};

type Attributes<ID extends string, P extends Props> = {
  type: "AWS::Lambda::Function";
  id: ID;
  functionName: string;
  functionArn: string;
  functionUrl: P["url"] extends true ? string : undefined;
};

export type Branded<T> = string & { __brand: T };

export type FunctionArn = Branded<"AWS::Lambda::Function.FunctionArn">;

export type Arn<Self> = ArnTag<Self, FunctionArn>;

export type FunctionLike<
  ID extends string = string,
  P extends Props = Props,
> = Resource<ID, P> & {
  type: "AWS::Lambda::Function";
  arn<Self>(this: Self): Effect.Effect<FunctionArn, never, Arn<Self>>;
  provider: Provider;
};

// TODO(sam): implement
export declare const arn: <F extends FunctionLike>(
  func: F,
) => Layer.Layer<Arn<F>, never, never>;

export type Handler<Self extends FunctionLike = FunctionLike> = {
  self: Self;
  (event: any, ctx: any): Promise<any>;
};

export type Function<
  ID extends string = string,
  P extends Props = Props,
> = Context.TagClass<P, ID, Attributes<ID, P>> &
  FunctionLike<ID, P> & {
    serve: <Self extends FunctionLike<ID, P>, Err, Req>(
      this: Self,
      handler: (
        event: HttpServerRequest,
      ) => Effect.Effect<HttpServerResponse, Err, Req>,
    ) => Effect.Effect<Handler<Self>, Err, Req> & {
      consume: <Q>(
        queue: Q,
        consumer: (batch: any) => Effect.Effect<any>,
      ) => Effect.Effect<any>;
    };
    consume: <Q>(queue: Q, consumer: Effect.Effect<any>) => Effect.Effect<any>;
  };

export const Tag = <ID extends string, P extends Props>(
  id: ID,
  props: P,
): Function<ID, P> =>
  Object.assign(Context.Tag(id)(), {
    id,
    props,
    provider: Provider,
  }) as any as Function<ID, P>;

export class Client extends Context.Tag("AWS::Lambda")<
  Client,
  LambdaClient
>() {}

export const client = createAWSServiceClientLayer(Client, LambdaClient);

export interface ProviderProps extends Props {
  policy?: Policy;
}

export class Provider extends Context.Tag("AWS::Lambda::Function")<
  Provider,
  ResourceProvider<ProviderProps, Attributes<string, Props>>
>() {}

export const provider = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const lambda = yield* Client;
    const iam = yield* IAM.Client;
    const region = yield* Region;
    const app = yield* App;
    const assets = yield* Assets;

    const createFunctionName = (id: string) =>
      `${app.name}-${app.stage}-${id}-${region}`;
    const createRoleName = (id: string) =>
      `${app.name}-${app.stage}-${id}-${region}`;
    return {
      create: Effect.fn(function* ({ id, news }) {
        const roleName = createRoleName(id);
        const functionName = news.functionName ?? createFunctionName(id);
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
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({
                RoleName: roleName,
              }),
            ),
          );
        yield* iam.attachRolePolicy({
          RoleName: roleName,
          PolicyArn:
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        });

        const handler = news.handler ?? "default";
        const code = yield* bundle({
          entryPoints: [news.main],
          // we use a virtual entry point so that
          stdin: {
            contents: `import { ${handler} as handler } from "${path.relative(process.cwd(), news.main)}";\nexport default handler;`,
            resolveDir: ".",
            loader: "ts",
            sourcefile: "__index.ts",
          },
          bundle: true,
          format: "esm",
          platform: "node",
          target: "node22",
          sourcemap: true,
          treeShaking: true,
        });

        const func = yield* lambda
          .createFunction({
            FunctionName: functionName,
            Handler: news.functionName,
            Role: role.Role.Arn,
            Code: {},
            Runtime: "nodejs22.x",
          })
          .pipe(
            Effect.catchTag("ResourceConflictException", () =>
              lambda
                .getFunction({
                  FunctionName: functionName,
                })
                .pipe(Effect.map((f) => f.Configuration!)),
            ),
          );

        return {
          id,
          type: "AWS::Lambda::Function",
          functionArn: func.FunctionArn!,
          functionName,
          functionUrl: undefined,
        } satisfies Attributes<string, Props>;
      }),
      update: Effect.fn(function* (input) {
        // return lambda.updateFunctionConfiguration({
        //   FunctionName: input.id,
        //   Handler: "index.handler",
        // });
        return null as any;
      }),
      delete: Effect.fn(function* (input) {
        // return lambda.deleteFunction({
        //   FunctionName: input.id,
        // });
        return null as any;
      }),
    };
  }),
);

export type InvokeFunction<F extends FunctionLike> = Allow<
  "lambda:InvokeFunction",
  F
>;

// TODO(sam): implement
export declare const InvokeFunction: <F extends FunctionLike>(
  func: F,
) => InvokeFunction<F>;

export const invoke = <F extends FunctionLike>(func: F, input: any) =>
  Effect.gen(function* () {
    const lambda = yield* Client;
    const functionArn = yield* func.arn();
    yield* allow<InvokeFunction<F>>();
    return yield* lambda.invoke({
      FunctionName: functionArn,
      InvocationType: "RequestResponse",
      Payload: JSON.stringify(input),
    });
  });

export const toHandler = (effect: Effect.Effect<Handler, any, Statement>) =>
  null;

export const make = <F extends FunctionLike, Req>(
  self: F,
  _impl: Effect.Effect<Handler<F>, any, Req>,
  policy: Policy<Extract<Req, Statement>>,
): Effect.Effect<
  {
    [id in F["id"]]: Bound<F, Extract<Req, Statement>>;
  } & {
    [id in Extract<Req, Statement>["resource"]["id"]]: Extract<
      Extract<Req, Statement>["resource"],
      { id: id }
    >;
  },
  never,
  | Provider
  | Extract<Extract<Req, Statement>["resource"], { provider: any }>["provider"]
> =>
  Effect.gen(function* () {
    return {
      [self.id]: {
        type: "bound",
        target: self,
        bindings: policy.statements,
      } satisfies Bound<F, Extract<Req, Statement>>,
      ...(Object.fromEntries(
        policy.statements.map((statement) => [
          statement.resource.id,
          statement.resource,
        ]),
      ) as {
        [id in Extract<Req, Statement>["resource"]["id"]]: Extract<
          Extract<Req, Statement>["resource"],
          { id: id }
        >;
      }),
    };
  });
