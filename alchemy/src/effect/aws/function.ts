import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { Lambda as LambdaClient } from "itty-aws/lambda";
import type { LifecycleHandlers } from "../lifecycle.ts";
import { allow, type Allow, type Policy, type Statement } from "../policy.ts";
import type { Tag as ArnTag } from "./arn.ts";
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
};

// TODO(sam): implement
export declare const arn: <F extends FunctionLike>(
  func: F,
) => Layer.Layer<Arn<F>, never, never>;

export type Handler<Self extends FunctionLike = FunctionLike, Out = any> = {
  self: Self;
  (event: any, ctx: any): Promise<Out>;
};

export type Resource<
  ID extends string = string,
  P extends Props = Props,
> = Context.TagClass<P, ID, Attributes<ID, P>> &
  FunctionLike<ID, P> & {
    serve: <Self extends FunctionLike<ID, P>, Out, Err, Req>(
      this: Self,
      handler: (event: any, ctx: any) => Effect.Effect<Out, Err, Req>,
    ) => Effect.Effect<Handler<Self, Out>, Err, Req> & {
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
  Object.assign(Context.Tag(id)(), props) as any as Resource<ID, P>;

export class Client extends Context.Tag("AWS::Lambda")<
  Client,
  LambdaClient
>() {}

export const client = Layer.effect(
  Client,
  Effect.gen(function* () {
    const region = yield* Region.Region;
    const credentials = yield* Credentials.Credentials;
    return new LambdaClient({
      region,
      credentials: {
        accessKeyId: Redacted.value(credentials.accessKeyId),
        secretAccessKey: Redacted.value(credentials.secretAccessKey),
        sessionToken: credentials.sessionToken
          ? Redacted.value(credentials.sessionToken)
          : undefined,
      },
    });
  }),
);

export const clientFromEnv = Layer.provide(
  client,
  Layer.merge(Credentials.fromEnv, Region.fromEnv),
);

export class Lifecycle extends Context.Tag("AWS::Lambda::Lifecycle")<
  Lifecycle,
  LifecycleHandlers<Props, Attributes<string, Props>>
>() {}

export const lifecycle = Layer.effect(
  Lifecycle,
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

export const lifecycleFromEnv = Layer.provide(lifecycle, clientFromEnv);

export type Invoke<F extends FunctionLike> = Allow<
  "lambda:InvokeFunctionUrl",
  F
>;

// TODO(sam): implement
export declare const Invoke: <F extends FunctionLike>(func: F) => Invoke<F>;

export const invoke = <F extends FunctionLike>(func: F, input: any) =>
  Effect.gen(function* () {
    const lambda = yield* Client;
    const functionArn = yield* func.arn();
    yield* allow<Invoke<F>>();
    return yield* lambda
      .invoke({
        FunctionName: functionArn,
        InvocationType: "RequestResponse",
        Payload: JSON.stringify(input),
      })
      .pipe(Effect.catchAll(() => Effect.void));
  });

export const toHandler = (effect: Effect.Effect<Handler, never, Statement>) =>
  null;

export const make = <Self extends FunctionLike, Req>(
  self: Self,
  impl: Effect.Effect<Handler<Self>, never, Req>,
  policy: Policy.Collect<Req>,
) =>
  Effect.gen(function* () {
    const lifecycle = yield* Lifecycle;
    return {
      type: "AWS::Lambda::Function",
      functionArn: "todo",
      functionUrl: "todo",
    } as {
      type: "AWS::Lambda::Function";
      functionArn: string;
      functionUrl: Self["props"]["url"] extends true ? string : undefined;
    };
  });
