import * as Layer from "effect/Layer";
import { Connector, ConnectorProvider } from "./Connector.ts";
import { Linker, LinkerProvider } from "./Linker.ts";

export const resources = [Connector, Linker];
export const layers = () =>
  Layer.mergeAll(ConnectorProvider(), LinkerProvider());
