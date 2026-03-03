// TODO: not sure if we should be depending on react types
import type { JSX } from "react";

import * as ServiceMap from "effect/ServiceMap";
import type { Aspect } from "../Agent/Aspect.ts";

export type TuiPlugin<A extends Aspect> = ServiceMap.Service<
  `TuiPlugin<${A["type"]}>`,
  TuiPluginService<A>
>;

export interface TuiPluginService<A extends Aspect> {
  /** Render a list of Aspects in the TUI sidebar */
  sidebar?: (a: A[]) => JSX.Element;
  /** Render the content of an Aspect in the TUI */
  content?: (a: A) => JSX.Element;
}

export const TuiPlugin = <A extends Aspect>(type: A["type"]): TuiPlugin<A> =>
  ServiceMap.Service<`TuiPlugin<${A["type"]}>`, TuiPluginService<A>>(
    `TuiPlugin<${type}>`,
  );
