import * as Azure from "@alchemy.run/azure";
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ApiLive, { Api } from "./src/Api.ts";
import { Cluster, Notes } from "./src/infra.ts";

export default Alchemy.Stack(
  "AzureAksExample",
  {
    providers: Layer.mergeAll(Azure.providers(), Kubernetes.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cluster = yield* Cluster;
    const notes = yield* Notes;
    // `ApiLive` (provided below) carries the Deployment's props and init.
    const api = yield* Api;
    return {
      url: api.url,
      clusterName: cluster.clusterName,
      resourceGroup: cluster.resourceGroup,
      kubeletObjectId: cluster.kubeletIdentity.objectId,
      serviceAccount: api.serviceAccountName,
      namespace: api.namespace,
      identity: api.identity,
      registry: api.registry,
      containerId: notes.containerId,
    };
  }).pipe(Effect.provide(ApiLive)),
);
