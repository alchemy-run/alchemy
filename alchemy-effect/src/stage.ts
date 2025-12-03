import type { Resource, AnyResource } from "./resource.ts";
const args = typeof process !== "undefined" ? process.argv.slice(2) : [];

const parseOption = (argName: string) => {
  const i = args.indexOf(argName);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};

export const $stage =
  import.meta.env.STAGE ?? parseOption("--stage") ?? `dev-${import.meta.env.USER ?? "unknown"}`;

export interface StageConfig {}

export const isStageRef = (s: any): s is StageRef<any> => s && s.kind === "StageRef";

export interface StageRef<R extends Resource<string, string, any, any> = AnyResource> {
  kind: "StageRef";
  stack?: string;
  stage: string;
  resourceId: R["id"];
  /** @internal phantom */
  R: R;
}

export namespace Stage {
  export function ref<R extends Resource<string, string, any, any>>(resource: R["id"]): StageRef<R>;
  export function ref<R extends Resource<string, string, any, any>>(
    resource: R["id"],
    stage: string,
  ): StageRef<R>;
  export function ref(resourceId: any, stage: any = $stage): StageRef<any> {
    return {
      kind: "StageRef",
      resourceId,
      stage,
      R: undefined!,
    };
  }
  export namespace current {
    export const ref = <R extends Resource<string, string, any, any>>(
      resourceId: R["id"],
    ): StageRef<R> => ({
      kind: "StageRef",
      resourceId,
      stage: $stage,
      R: undefined!,
    });
  }
}
