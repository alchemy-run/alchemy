import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Path } from "effect/Path";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { DotAlchemy } from "./Config.ts";
import type { ResourceBinding, ResourceLike } from "./Resource.ts";
import { Stage } from "./Stage.ts";

export type StackServices =
  | Stack
  | Stage
  | Scope
  | FileSystem
  | Path
  | DotAlchemy
  | HttpClient;

export class Stack extends ServiceMap.Service<
  Stack,
  Omit<StackSpec, "output">
>()("Stack") {}

export interface StackSpec<Output = any> {
  name: string;
  stage: string;
  // @internal
  resources: {
    [logicalId: string]: ResourceLike;
  };
  bindings: {
    [logicalId: string]: ResourceBinding[];
  };
  output: Output;
}

export const StackName = Stack.use((stack) => Effect.succeed(stack.name));

export const make =
  <const Name extends string, ROut = never>(
    name: Name,
    providers: Layer.Layer<ROut, never, StackServices>,
  ) =>
  <A, Err = never, Req extends ROut | StackServices = never>(
    effect: Effect.Effect<A, Err, Req>,
  ) =>
    Effect.all([
      Stack.asEffect(),
      Effect.services<ROut | StackServices>(),
    ]).pipe(
      Effect.map(([stack, services]) =>
        effect.pipe(
          Effect.map((output) => ({
            output,
            services,
            ...stack,
          })),
        ),
      ),
      Effect.provide(providers),
      Effect.provideServiceEffect(
        Stack,
        Stage.asEffect().pipe(
          Effect.map(
            (stage) =>
              ({
                name,
                stage,
                resources: {},
                bindings: {},
              }) satisfies Stack["Service"],
          ),
        ),
      ),
    );
