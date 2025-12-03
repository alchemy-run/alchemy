import type { Resource, AnyResource } from "./resource.ts";

export const isRef = (s: any): s is Ref<any> => s && s.kind === "Ref";

export interface Ref<R extends Resource<string, string, any, any> = AnyResource> {
  kind: "Ref";
  stack?: string;
  stage: string;
  resourceId: R["id"];
  /** @internal phantom */
  R?: R;
}
