/**
 * The Kubernetes suite's front: a Deployment on the kind cluster calling
 * everything through the gateways, published on a node port.
 */
import * as Kubernetes from "@alchemy.run/kubernetes";
import { frontApp } from "../app.ts";
import { Kind } from "./cluster.ts";
import { Tally } from "./tally.ts";

export const FRONT_NAME = "cluster-front";

export default Kubernetes.Deployment(
  "ClusterKubeFront",
  {
    cluster: Kind,
    main: import.meta.url,
    name: FRONT_NAME,
    port: 3000,
    serviceType: "ClusterIP",
  },
  frontApp(Tally),
);
