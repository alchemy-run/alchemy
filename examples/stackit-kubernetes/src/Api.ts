import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { AppCluster, Domain } from "./infra.ts";

/**
 * An Effect program as a `Kubernetes.Deployment`. The class declares the workload,
 * and the default export is its Layer, with the props and the program.
 *
 * - `GET /` is a health route.
 * - `GET /zone` reads the bound DNS zone.
 *
 * `Stackit.DNS.GetZone` creates a service account with a key, grants the account
 * the `dns.zone.list` permission on the project, and binds the key into the container's env.
 */
export class Api extends Kubernetes.Deployment<Api>()("Api") {}

export default Api.make(
  Effect.gen(function* () {
    const cluster = yield* AppCluster;
    return {
      cluster,
      main: import.meta.url,
      port: 3000,
      serviceType: "LoadBalancer" as const,
    };
  }),
  Effect.gen(function* () {
    const getZone = yield* Stackit.DNS.GetZone(yield* Domain);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (new URL(request.url, "http://localhost").pathname === "/zone") {
          const { zone } = yield* getZone({});
          return yield* HttpServerResponse.json({ zoneId: zone.id });
        }
        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Stackit.DNS.GetZoneHttp)),
);
