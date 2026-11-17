/**
 * The HTTP front of the Kubernetes conformance suite: a Deployment on the
 * kind cluster calling the counter and a stream through the gateway, published on a
 * node port.
 */
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { durableStreamFront } from "../durable-stream-front.ts";
import { Kind, Services } from "./cluster.ts";

export const FRONT_NAME = "rivet-front";

export default Kubernetes.Deployment(
  "RivetKubeFront",
  {
    cluster: Kind,
    main: import.meta.url,
    name: FRONT_NAME,
    port: 3000,
    serviceType: "ClusterIP",
  },
  durableStreamFront.pipe(Effect.provide(Layer.mergeAll(Services, StreamFormat.Json))),
);
