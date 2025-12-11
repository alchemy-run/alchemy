import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { StackName, StackRef, Stack, StackResources } from "./stack.ts";
import { ref } from "./ref.ts";

export interface StageConfig {
  /**
   * Whether to retain the stage when destroying the stack.
   *
   * @default - true if the current stage starts with "prod"
   */
  retain?: boolean;

  /**
   * Whether to adopt resources that already exist during the created phase.
   *
   * @default false
   */
  adopt?: boolean;
}

export class Stage extends Context.Tag("Stage")<Stage, string>() {}

export type Stages<Req = never, Err = never> = {
  config: (stage: string) => StageConfig | Effect.Effect<StageConfig, Err, Req>;
  ref<S extends Stack>(name: StackName<S>): StackRefs<S>;
};

export const defineStages = <Req = never, Err = never>(
  config: (stage: string) => StageConfig | Effect.Effect<StageConfig, Err, Req>,
): Stages<Req, Err> => ({
  config,
  ref: <S extends Stack>(stack: StackName<NoInfer<S>>): StackRefs<S> => {
    const proxy = (get: (id: string) => any) =>
      new Proxy({}, { get: (_, id: string) => get(id) });
    const proxyStage = (stage: string) =>
      proxy((resourceId: string) =>
        ref({
          stack,
          stage,
          resourceId,
        }),
      );
    return proxy((stage) =>
      stage == "as"
        ? (builders: StackRefBuilders) =>
            proxy((stage: string) => {
              if (stage in builders) {
                const builder = builders[stage as keyof typeof builders];
                return typeof builder === "string"
                  ? proxyStage(stage)
                  : (...args: any[]) => proxyStage(builder(...args));
              }
              return proxyStage(stage);
            })
        : proxy((resourceId: string) =>
            ref({
              stack,
              stage,
              resourceId,
            }),
          ),
    ) as StackRefs<S>;
  },
});

export interface StackRefBuilders {
  [stage: string]: string | ((...args: any[]) => string);
}

export type StackRefs<S extends Stack> = {
  [stage in string]: StackRef<StackResources<S>>;
} & {
  as<Builders extends StackRefBuilders>(
    stages?: Builders,
  ): {
    [stage in Exclude<string, keyof Builders>]: StackRef<StackResources<S>>;
  } & {
    [builder in keyof Builders]: Builders[builder] extends string
      ? StackRef<StackResources<S>>
      : Builders[builder] extends (...args: infer Args) => any
        ? (...args: Args) => StackRef<StackResources<S>>
        : never;
  };
};
