import * as Stackit from "@alchemy.run/stackit";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { PullLogin, registryFor } from "./registry.ts";
import { Domain } from "./resources.ts";

/**
 * An Effect program on a STACKIT Container Application. By default it runs at most one
 * instance and may scale to zero between requests.
 *
 * - `GET /` returns the `GREETING` variable.
 * - `GET /zone` reads the bound DNS zone.
 *
 * An Application runs as no STACKIT identity. `Stackit.DNS.GetZone` creates a service
 * account with a key for it, grants the account the `dns.zone.list` permission on the project, and the key
 * reaches the application as an environment secret.
 */
export default class Api extends Stackit.ContainerApplications.Application<Api>()(
  "Api",
  Effect.gen(function* () {
    const login = yield* PullLogin;
    const registry = yield* registryFor("api");
    return {
      main: import.meta.url,
      environmentId: login.environmentId,
      registry,
      env: { GREETING: "hello from a container application" },
    };
  }),
  Effect.gen(function* () {
    const getZone = yield* Stackit.DNS.GetZone(yield* Domain);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://application");
        switch (url.pathname) {
          case "/":
            return HttpServerResponse.text(yield* Config.String("GREETING"));
          case "/zone": {
            const { zone } = yield* getZone({});
            return yield* HttpServerResponse.json({ zoneId: zone.id });
          }
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Stackit.DNS.GetZoneHttp)),
) {}
