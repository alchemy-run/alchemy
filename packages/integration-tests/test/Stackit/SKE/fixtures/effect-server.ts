import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { AdapterCluster, AdapterZone } from "./resources.ts";

/**
 * Effect-native `Kubernetes.Deployment` on SKE. The DNS binding takes the path of
 * any foreign host: a service account key bound into the container's env.
 */
export class SkeEffectServer extends Kubernetes.Deployment<SkeEffectServer>()("SkeEffectServer") {}

export default SkeEffectServer.make(
  Effect.gen(function* () {
    const cluster = yield* AdapterCluster;
    return {
      cluster,
      main: import.meta.url,
      port: 3000,
      serviceType: "LoadBalancer" as const,
    };
  }),
  Effect.gen(function* () {
    const getZone = yield* Stackit.DNS.GetZone(yield* AdapterZone);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (new URL(request.url, "http://localhost").pathname === "/zone") {
          const { zone } = yield* getZone({});
          return yield* HttpServerResponse.json({ zoneId: zone.id });
        }
        return HttpServerResponse.text("effect server");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Stackit.DNS.GetZoneHttp)),
);
