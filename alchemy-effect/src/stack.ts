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
import type { ApplyEffect } from "./apply.ts";
import { apply } from "./apply.ts";
import { DotAlchemy } from "./dot-alchemy.ts";
import type { Output } from "./output.ts";
import type { DerivePlan, Providers, TraverseResources } from "./plan.ts";
import type { Instance } from "./policy.ts";
import type { AnyResource } from "./resource.ts";
import type { AnyService } from "./service.ts";
import type { StageConfig } from "./stage.ts";
import { $stage } from "./stage.ts";
import * as State from "./state.ts";

export interface Stack<
  Name extends string = string,
  Resources extends (AnyResource | AnyService)[] = (AnyResource | AnyService)[],
> extends StageConfig {
  name: Name;
  resources: Resources;
  providers: Layer.Layer<
    Providers<Instance<Resources[number]>>,
    never,
    App.App | FileSystem | Path | DotAlchemy
  >;
  state?: Layer.Layer<State.State>;
}

export const defineStack = <
  const Name extends string,
  Resources extends (AnyResource | AnyService)[],
>(
  config: Stack<Name, Resources>,
): ApplyEffect<DerivePlan<Instance<Resources[number]>>> =>
  Effect.gen(function* () {
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

    const stack = App.make({ name: config.name, stage: $stage });

    const layers = Layer.provideMerge(
      Layer.provideMerge(providers, alchemy),
      Layer.mergeAll(platform, stack),
    );

    return yield* apply(...config.resources).pipe(Effect.provide(layers));
  }) as ApplyEffect<DerivePlan<Instance<Resources[number]>>>;

export interface StackRefConfig<S extends Stack> extends StageConfig {
  name: S["name"];
  stage?: string;
  parent?: string;
}

export namespace Stack {
  export function ref<S extends Stack>(
    options: StackRefConfig<S>,
  ): StackRef<Instance<S["resources"][number]>>;

  export function ref<S extends Stack>(name: S["name"], stage?: string) {
    return new Proxy(
      {},
      {
        get: (_, prop) => {
          // TODO(sam): implement
        },
      },
    ) as any;
  }
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
