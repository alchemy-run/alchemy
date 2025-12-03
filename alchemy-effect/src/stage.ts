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
}

export namespace Stages {
  export const of = <S extends Stack<any>>(
    stackName: Stack.Name<S>,
    config: (stage: string) => StageConfig,
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

  export const config =
    (config: { [stagePrefix: string]: StageConfig }) =>
    (stage: string = Stage.current) => {
      while (stage.includes("-")) {
        stage = stage.slice(0, -1);
        if (config[stage]) {
          return config[stage];
        }
      }
      const c = config[stage];
      if (!c) {
        throw new Error(`Config for stage ${stage} not found`);
      }
      return c;
    };
}
