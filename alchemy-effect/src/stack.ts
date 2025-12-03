import { FetchHttpClient } from "@effect/platform";
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
import { Stage, type StageConfig } from "./stage.ts";
import * as State from "./state.ts";

export interface StackConfig<
  Resources extends (AnyResource | AnyService)[] = (AnyResource | AnyService)[],
> extends StageConfig {
  // TODO(sam): type this properly
  stages: Stages;
  resources: Resources;
  providers: Layer.Layer<
    Providers<Instance<Resources[number]>>,
    never,
    App.App | FileSystem | Path | DotAlchemy
  >;
  state?: Layer.Layer<State.State>;
}

export interface StackOutput<Name extends string, Resources extends AnyResource | AnyService> {
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
>(
  stackName: Name,
  stackConfig:
    | StackConfig<Resources>
    | ((options: { stage: string; local?: boolean; watch?: boolean }) => StackConfig<Resources>),
): Stack<Name, Instance<Resources[number]>> =>
  Effect.gen(function* () {
    // TODO(sam): implement local and watch
    const config =
      typeof stackConfig === "function"
        ? stackConfig({ stage: Stage.current, local: false, watch: false })
        : stackConfig;
    const platform = Layer.mergeAll(NodeContext.layer, FetchHttpClient.layer, Logger.pretty);

    // select your providers
    const providers = config.providers;

    // override alchemy state store, CLI/reporting and dotAlchemy
    const alchemy = Layer.mergeAll(
      config.state ?? State.localFs,
      CLI.layer,
      // optional
      Alchemy.dotAlchemy,
    );

    const stack = App.make({ name: stackName, stage: Stage.current });

    const layers = Layer.provideMerge(
      Layer.provideMerge(providers, alchemy),
      Layer.mergeAll(platform, stack),
    );

    return yield* apply(...config.resources).pipe(
      Effect.provide(layers),
      Effect.map((resources) => ({
        stack: stackName,
        resources,
      })),
    );
  }) as Stack<Name, Instance<Resources[number]>>;

export interface StackRefConfig<S extends Stack> extends StageConfig {
  stack: S extends Stack<infer Name, any> ? Name : never;
  stage?: string;
}

export namespace Stack {
  export type Name<S extends Stack> = S extends Stack<infer Name, infer _> ? Name : never;

  export type Outputs<S extends Stack> =
    S extends Stack<infer _, infer Resources> ? Resources : never;

  export const ref = <S extends Stack>(options: StackRefConfig<S>): StackRef<Stack.Outputs<S>> =>
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
  [Id in TraverseResources<Resources>["id"]]: Extract<TraverseResources<Resources>, { id: Id }>;
};
