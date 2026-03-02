// TODO: not sure if we should be depending on react types
import type { JSX } from "react";

import * as Context from "effect/Context";
import type { Aspect } from "../Agent/Aspect.ts";

export type TuiPlugin<A extends Aspect> = Context.Tag<
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
  Context.GenericTag<`TuiPlugin<${A["type"]}>`, TuiPluginService<A>>(
    `TuiPlugin<${type}>`,
  );
