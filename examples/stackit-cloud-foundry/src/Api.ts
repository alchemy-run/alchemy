import * as Stackit from "@alchemy.run/stackit";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { registryFor, Stage } from "./deployer.ts";

/**
 * An Effect program on a Cloud Foundry App. Alchemy pushes its image and starts it in
 * the space, with a route of its own.
 *
 * - `GET /` returns the `GREETING` variable.
 * - `GET /space` reads the space the app runs in.
 *
 * `Stackit.CloudFoundry.GetSpace` creates a service account with a key for the app,
 * which reaches it as an environment variable. The role is granted on the project,
 * the narrowest scope STACKIT binds.
 */
export default class Api extends Stackit.CloudFoundry.App<Api>()(
  "Api",
  Effect.gen(function* () {
    const stage = yield* Stage;
    const registry = yield* registryFor("api");
    return {
      spaceId: stage.role.spaceId,
      credentials: stage.credentials,
      main: import.meta.url,
      registry,
      memoryInMb: 256,
      env: { GREETING: "hello from an effect app" },
    };
  }),
  Effect.gen(function* () {
    const stage = yield* Stage;
    const getSpace = yield* Stackit.CloudFoundry.GetSpace(stage.space);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://app");
        switch (url.pathname) {
          case "/":
            return HttpServerResponse.text(yield* Config.String("GREETING"));
          case "/space": {
            const space = yield* getSpace();
            return yield* HttpServerResponse.json({ spaceId: space.guid, name: space.name });
          }
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Stackit.CloudFoundry.GetSpaceHttp)),
) {}
