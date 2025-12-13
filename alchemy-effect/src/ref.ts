import type { Resource, AnyResource } from "./resource.ts";
import * as Output from "./output.ts";

// special runtime-only symbol for probing the Ref proxy for its metadata
const RefMetadata = Symbol.for("alchemy/RefMetadata");

export const isRef = (s: any): s is Ref<any> =>
  s && s[RefMetadata] !== undefined;

export const getRefMetadata = <R extends Resource<string, string, any, any>>(
  ref: Ref<R>,
): RefMetadata<R> => (ref as any)[RefMetadata];

export interface Ref<
  R extends Resource<string, string, any, any> = AnyResource,
> {
  /** @internal phantom */
  Ref: R;
}

export interface RefMetadata<R extends Resource<string, string, any, any>> {
  stack?: string;
  stage?: string;
  resourceId: R["id"];
}

export const ref = <R extends Resource<string, string, any, any>>({
  stack,
  resourceId,
  stage,
}: RefMetadata<R>): Ref<R> => {
  const ref = new Proxy(
    {},
    {
      get: (_, prop) => {
        if (prop === RefMetadata) {
          return {
            stack,
            stage,
            resourceId,
          };
        }
        return (Output.of(ref) as any)[prop];
      },
    },
  ) as Ref<R>;
  return ref;
};
