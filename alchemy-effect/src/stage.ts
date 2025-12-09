import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { type StackRef, Stack } from "./stack.ts";

export interface StageConfig {
  /**
   * Whether to retain the stage when destroying the stack.
   *
   * @default Stage.current.startsWith("prod")
   */
  retain?: boolean;
}

export class Stage extends Context.Tag("Stage")<Stage, string>() {}

export type Stages<Req = never, Err = never> = {
  config: (stage: string) => StageConfig | Effect.Effect<StageConfig, Err, Req>;
  ref<S extends Stack>(name: Stack.Name<S>): StackRefs<S>;
};

export const defineStages = <Req = never, Err = never>(
  config: (stage: string) => StageConfig | Effect.Effect<StageConfig, Err, Req>,
): Stages<Req, Err> => ({
  config,
  ref: <S extends Stack>(name: Stack.Name<NoInfer<S>>): StackRefs<S> =>
    new Proxy(() => {}, {
      get: (_, prop) => {
        return undefined!;
      },
      apply: (_, thisArg, args) => {
        return undefined!;
      },
    }) as StackRefs<S>,
});

type StackRefs<S extends Stack> = {
  [stage in string]: StackRef<Stack.Resources<S>>;
} & {
  <
    Builders extends {
      [stage in string]: string | ((...args: any[]) => string);
    },
  >(
    stages?: Builders,
  ): {
    [stage in Exclude<string, keyof Builders>]: StackRef<Stack.Resources<S>>;
  } & {
    [builder in keyof Builders]: Builders[builder] extends string
      ? StackRef<Stack.Resources<S>>
      : Builders[builder] extends (...args: infer Args) => any
        ? (...args: Args) => StackRef<Stack.Resources<S>>
        : never;
  };
};

export const validateStage = (stage: string) => {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(stage)) {
    throw new Error(
      `Stage '${stage}' is invalid. It can only contain lowercase letters, numbers, and hyphens.`,
    );
  }
};
