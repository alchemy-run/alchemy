import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { Binding } from "./Binding.ts";
import { DotAlchemy } from "./Config.ts";
import type { ResourceLike } from "./Resource.ts";
import { Stage } from "./Stage.ts";

export type StackServices =
  | Stack
  | Stage
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
    [logicalId: string]: Binding[];
  };
  output: Output;
}

export const StackName = Stack.use((stack) => Effect.succeed(stack.name));

export const make: {
  <const Name extends string>(
    name: Name,
  ): <A, Err = never>(
    effect: Effect.Effect<A, Err, StackServices>,
  ) => Effect.Effect<StackSpec<A>, Err, StackServices>;
  <const Name extends string, A, Err = never>(
    name: Name,
    effect: Effect.Effect<A, Err, StackServices>,
  ): Effect.Effect<StackSpec<A>, Err, StackServices>;
} = ((name: string, effect?: Effect.Effect<any, any, any>) => {
  const make = (effect: Effect.Effect<any, any, any>) =>
    effect.pipe(
      Effect.flatMap((output) =>
        Stack.asEffect().pipe(
          Effect.map((stack) => ({
            output,
            ...stack,
          })),
        ),
      ),
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
  return effect ? make(effect) : make;
}) as any;
