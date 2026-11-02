import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ApiLive, { Api } from "./src/Api.ts";
import { AppCluster, Domain } from "./src/infra.ts";

/**
 * A `Stackit.SKE.Cluster` with two `Kubernetes.Deployment`s: an Effect program
 * bundled into a generated image, and a public image with no build. Each sits behind
 * a load balancer of its own.
 */
export default Alchemy.Stack(
  "StackitKubernetesExample",
  {
    providers: Layer.mergeAll(Stackit.providers(), Kubernetes.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cluster = yield* AppCluster;
    const domain = yield* Domain;
    const api = yield* Api;
    const web = yield* Kubernetes.Deployment("Web", {
      cluster,
      image: "nginx:1.27",
      port: 80,
      serviceType: "LoadBalancer",
    });

    return {
      clusterName: cluster.clusterName,
      projectId: cluster.projectId,
      region: cluster.region,
      zoneId: domain.zoneId,
      apiUrl: api.url,
      webUrl: web.url,
    };
  }).pipe(Effect.provide(ApiLive)),
);
