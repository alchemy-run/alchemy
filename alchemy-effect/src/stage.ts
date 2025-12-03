import type { Resource } from "./resource.ts";
import type { Ref } from "./ref.ts";
import { Stack } from "./stack.ts";

const args = typeof process !== "undefined" ? process.argv.slice(2) : [];

const parseOption = (argName: string) => {
  const i = args.indexOf(argName);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};

export interface StageConfig {}

export namespace Stage {
  export const current =
    import.meta.env.STAGE ??
    parseOption("--stage") ??
    `dev-${import.meta.env.USER ?? import.meta.env.USERNAME ?? "unknown"}`;

  export const parent = current.includes("-")
    ? current.split("-").slice(0, -1).join("-")
    : undefined;

  export const root = current.includes("-") ? current.split("-")[0] : current;

  export const ref = <R extends Resource<string, string, any, any>>(
    resourceId: R["id"],
    stage?: string,
  ): Ref<R> => ({
    kind: "Ref",
    resourceId,
    stage: stage ?? current,
  });

  type Parse<Stages extends string, Components extends string[] = []> = Stages extends ""
    ? Components
    : Stages extends `${infer Root}-${infer Rest}`
      ? string extends Rest
        ? [...Components, Root, ...string[]]
        : Parse<Rest, [...Components, Root]>
      : [...Components, Stages];

  export const config = <Stage extends string>(
    config: (components: Parse<Stage>, stage: Stage) => StageConfig,
  ) => {
    const _config = (stage: Stage) => {
      const stages = stage.split("-");
      if (stages.length === 0) {
        throw new Error(`Stage '${stage}' is not valid`);
      }
      return config(stages as Parse<Stage>, stage);
    };
    return Object.assign(_config, {
      of: <S extends Stack<any>>(stackName: Stack.Name<S>) => Stages.of(stackName, _config),
      current: _config(Stage.current as Stage),
      parent: Stage.parent ? _config(Stage.parent as Stage) : undefined,
      root: _config(Stage.root as Stage),
    });
  };
}

export namespace Stages {
  export const of = <S extends Stack<any>, Stages extends string>(
    stackName: Stack.Name<S>,
    config: (stage: Stages) => StageConfig,
  ) => {
    const ref = (stage: string = Stage.current, suffix?: string) =>
      Stack.ref<S>({
        stack: stackName,
        stage: suffix ? `${stage}-${suffix}` : stage,
        ...config,
      });
    return {
      ref,
      prod: ref("prod"),
      staging: (pr?: number) => ref("staging", pr?.toString()),
      dev: (user: string = import.meta.env.USER!) => ref("dev", user),
      parent: Stage.parent ? ref(Stage.parent) : undefined,
      root: ref(Stage.root),
    };
  };
}
