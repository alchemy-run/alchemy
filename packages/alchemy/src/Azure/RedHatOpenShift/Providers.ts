import * as Layer from "effect/Layer";
import { Cluster, ClusterProvider } from "./Cluster.ts";

export const resources = [Cluster];
export const layers = () => Layer.mergeAll(ClusterProvider());
