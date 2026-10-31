/**
 * The HTTP front of the Kubernetes conformance suite: a Deployment on the
 * kind cluster calling the counter through the gateway, published on a
 * node port.
 */
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Effect from "effect/Effect";
import { conformanceFetch } from "../../../Cloudflare/Workers/conformance/routes.ts";
import { Counter } from "../counter-declaration.ts";
import { Kind } from "./cluster.ts";

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
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }),
);
