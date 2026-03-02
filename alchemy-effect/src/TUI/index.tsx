import { render } from "@opentui/solid";
import * as Layer from "effect/Layer";
import {
  createContext,
  createSignal,
  type Accessor,
  type ParentProps,
} from "solid-js";
import {
  deriveGraph,
  type AspectIndex,
  type Organization,
} from "../Agent/index.ts";

import type { TuiPlugin } from "./plugin.ts";
import { ThemeProvider } from "./theme/theme.tsx";

export const defineTui = <Org extends Organization>(organization: Org) => {
  const graph = deriveGraph(organization);
  return {
    GraphContext: createContext<Org | null>(null),
  };
};

export interface GraphProviderProps<
  Org extends Organization,
> extends ParentProps {
  plugins: Layer.Layer<TuiPlugin<Org>>;
}

export const GraphProvider = <Org extends Organization>(
  props: GraphProviderProps<Org>,
) => {
  const [graph, setGraph] = createSignal<AspectIndex<Org> | null>(null);
  const GraphContext = createContext<{
    graph: Accessor<AspectIndex<Org> | null>;
    setGraph: (graph: AspectIndex<Org>) => void;
  }>();

  return (
    <GraphContext.Provider
      value={{
        graph,
        setGraph,
      }}
    >
      {props.children}
    </GraphContext.Provider>
  );
};

render(
  () => (
    <ThemeProvider mode="dark">
      {/* <GraphProvider> */}
      <text>Hello, World!</text>
      {/* </GraphProvider> */}
    </ThemeProvider>
  ),
  {
    targetFps: 60,
    exitOnCtrlC: true,
  },
);
