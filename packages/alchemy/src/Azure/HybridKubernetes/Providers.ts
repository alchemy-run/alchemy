import * as Layer from "effect/Layer";
import {
  ConnectedCluster,
  ConnectedClusterProvider,
} from "./ConnectedCluster.ts";

export const resources = [ConnectedCluster];
export const layers = () => Layer.mergeAll(ConnectedClusterProvider());
