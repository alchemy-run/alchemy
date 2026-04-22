/**
 * Api worker — calls the paired DO which tries to start the Container.
 *
 * The critical wiring is `const containers = yield* MyContainerDO;` which
 * injects the DO stub. Invoking `containers.getByName(...).hello()` at runtime
 * will hit the bug: the DO body's `Cloudflare.Container.bind(MyContainer)` is
 * missing its FK linkage to the Container app because of the circular Output
 * dependency documented in issue #72.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import MyContainerDO from "./MyContainerDO.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.path,
    observability: {
      enabled: true,
    },
  },
  Effect.gen(function* () {
    const containers = yield* MyContainerDO;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");

        if (url.pathname === "/hello") {
          const stub = containers.getByName("default");
          const body = yield* stub.hello().pipe(Effect.orDie);
          return HttpServerResponse.text(body);
        }

        if (url.pathname === "/health") {
          const stub = containers.getByName("default");
          const body = yield* stub.health().pipe(Effect.orDie);
          return HttpServerResponse.text(body);
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
