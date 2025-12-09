import * as ConfigProvider from "effect/ConfigProvider";
import { FetchHttpClient, type HttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { FileSystem } from "@effect/platform/FileSystem";
import { Path } from "@effect/platform/Path";
import * as Alchemy from "alchemy-effect";
import * as CLI from "alchemy-effect/cli";
import { Logger } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as App from "./app.ts";
import { apply, type AppliedPlan } from "./apply.ts";
import { DotAlchemy } from "./dot-alchemy.ts";
import type { Output } from "./output.ts";
import type { DerivePlan, Providers, TraverseResources } from "./plan.ts";
import type { Instance } from "./policy.ts";
import type { AnyResource } from "./resource.ts";
import type { AnyService } from "./service.ts";
import { Stage, type StageConfig, type Stages } from "./stage.ts";
import * as State from "./state.ts";
import { asEffect } from "./util.ts";

export interface StackConfig<
  Name extends string,
  Resources extends (AnyResource | AnyService)[] = (AnyResource | AnyService)[],
  Req = never,
  Err = never,
> {
  name: Name;
  stages: Stages<Req, Err>;
  resources: Resources;
  providers: Layer.Layer<
    Providers<Instance<Resources[number]>>,
    any,
    App.App | FileSystem | Path | DotAlchemy | HttpClient.HttpClient
  >;
  state?: Layer.Layer<State.State>;
}

export interface StackOutput<
  Name extends string,
  Resources extends AnyResource | AnyService,
> {
  /** @internal */
  stack: Name;
  resources: AppliedPlan<DerivePlan<Resources>>;
}

export type Stack<
  Name extends string = string,
  Resources extends AnyResource | AnyService = AnyResource | AnyService,
> = Effect.Effect<
  {
    [k in keyof StackOutput<Name, Resources>]: StackOutput<Name, Resources>[k];
  },
  Alchemy.PlanRejected
>;

export const defineStack = <
  const Name extends string,
  Resources extends (AnyResource | AnyService)[],
  Req = never,
  Err = never,
>(
  stack: StackConfig<Name, Resources, Req, Err>,
): Stack<Name, Instance<Resources[number]>> =>
  Effect.gen(function* () {
    const stackName = stack.name;
    const stage = yield* Stage;
    const _stageConfig = yield* asEffect(stack.stages.config(stage));

    // TODO(sam): implement local and watch
    const platform = Layer.mergeAll(
      NodeContext.layer,
      FetchHttpClient.layer,
      Logger.pretty,
    );

    // select your providers
    const providers = stack.providers;

    // override alchemy state store, CLI/reporting and dotAlchemy
    const alchemy = Layer.mergeAll(
      stack.state ?? State.localFs,
      CLI.layer,
      // optional
      Alchemy.dotAlchemy,
    );

    const layers = Layer.provideMerge(
      Layer.provideMerge(providers, alchemy),
      Layer.mergeAll(platform, App.make({ name: stackName, stage })),
    );

    return yield* apply(...stack.resources).pipe(
      Effect.provide(layers),
      Effect.map((resources) => ({
        stack: stackName,
        resources,
      })),
    );
  }).pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())) as Stack<
    Name,
    Instance<Resources[number]>
  >;

export interface StackRefConfig<S extends Stack> extends StageConfig {
  stack: S extends Stack<infer Name, any> ? Name : never;
  stage?: string;
}

export namespace Stack {
  export type Name<S extends Stack> =
    S extends Stack<infer Name, infer _> ? Name : never;

  export type Resources<S extends Stack> =
    S extends Stack<infer _, infer Resources> ? Resources : never;

  export const ref = <S extends Stack>(
    options: StackRefConfig<S>,
  ): StackRef<Stack.Resources<S>> =>
    new Proxy(
      {},
      {
        get: (_, prop) => {
          // TODO(sam): implement
        },
      },
    ) as any;
}

export type StackRef<Resources extends AnyResource | AnyService> = {
  [Id in keyof Outputs<Resources>]: Outputs<Resources>[Id];
};

type Outputs<Resources extends AnyResource | AnyService> = {
  [Id in keyof AsRecord<Resources>]: {
    [attr in keyof AsRecord<Resources>[Id]["attr"]]: Output.Of<
      AsRecord<Resources>[Id]["attr"][attr]
    >;
  };
};

type AsRecord<Resources extends AnyResource | AnyService> = {
  [Id in TraverseResources<Resources>["id"]]: Extract<
    TraverseResources<Resources>,
    { id: Id }
  >;
};
