import * as ServiceMap from "effect/ServiceMap";
import type { Aspect } from "./Aspect.ts";

export type ContextPlugin<A extends Aspect> = ServiceMap.Service<
  `ContextPlugin<${A["type"]}>`,
  ContextPluginService<A>
>;

export interface ContextPluginService<A extends Aspect> {
  context: (a: A) => string;
}

export const ContextPlugin = <A extends Aspect>(
  type: A["type"],
): ContextPlugin<A> =>
  ServiceMap.Service<`ContextPlugin<${A["type"]}>`, ContextPluginService<A>>(
    `ContextPlugin<${type}>`,
  );
