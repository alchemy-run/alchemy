import * as Layer from "effect/Layer";
import { CloudHsmCluster, CloudHsmClusterProvider } from "./CloudHsmCluster.ts";

export const resources = [CloudHsmCluster];
export const layers = () => Layer.mergeAll(CloudHsmClusterProvider());
