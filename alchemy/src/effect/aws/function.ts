import type { HttpServerRequest } from "@effect/platform/HttpServerRequest";
import type { HttpServerResponse } from "@effect/platform/HttpServerResponse";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Lambda as LambdaClient } from "itty-aws/lambda";
import { phantom } from "../phantom.ts";
import { allow, type Allow, type Policy, type Statement } from "../policy.ts";
import type { Provider as ResourceProvider } from "../provider.ts";
import type { Tag as ArnTag } from "./arn.ts";
import { createAWSServiceClientLayer } from "./client.ts";
import * as Credentials from "./credentials.ts";
import * as Region from "./region.ts";

type Props = {
  url?: boolean;
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
> = {
  id: ID;
  type: "AWS::Lambda::Function";
  props: P;
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

export type Resource<
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
): Resource<ID, P> =>
  Object.assign(Context.Tag(id)(), {
    id,
    props,
    provider: phantom<Provider>(),
  }) as any as Resource<ID, P>;

export class Client extends Context.Tag("AWS::Lambda")<
  Client,
  LambdaClient
>() {}

export const client = createAWSServiceClientLayer(Client, LambdaClient);

export const clientFromEnv = Layer.provide(
  client,
  Layer.merge(Credentials.fromEnv, Region.fromEnv),
);

export class Provider extends Context.Tag("AWS::Lambda::Lifecycle")<
  Provider,
  ResourceProvider<Props, Attributes<string, Props>>
>() {}

export const provider = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const lambda = yield* Client;
    return {
      create: Effect.fn(function* (input) {
        yield* lambda
          .createFunction({
            FunctionName: input.id,
            Handler: "index.handler",
            Role: "arn:aws:iam::123456789012:role/LambdaExecutionRole",
            Code: { ZipFile: "index.handler" },
          })
          .pipe(Effect.catchAll(() => Effect.void));
        return null as any;
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

export const providerFromEnv = Layer.provide(provider, clientFromEnv);

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

export declare const make: <Self extends FunctionLike, Req>(
  self: Self,
  impl: Effect.Effect<Handler<Self>, any, Req>,
  policy: Policy<Extract<Req, Statement>>,
) => Effect.Effect<
  Main<Self>,
  never,
  Provider | Extract<Req, Statement>["resource"]["provider"]
>;

export type MainScript = Branded<"AWS::Lambda::Function.Main">;

export type Main<Self> = ArnTag<Self, MainScript>;

export declare const main: <F extends FunctionLike>(
  func: F,
  file: string,
) => Layer.Layer<Main<F>, never, never>;
