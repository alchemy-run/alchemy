/**
 * Container runtime — default-exports `MyContainer.make(Effect.gen(...))`.
 *
 * This file is pointed-to by `MyContainer`'s `main:` option. Alchemy bundles it
 * separately from the DO-side entry. In real projects this is where the heavy
 * runtime deps live (sharp, impit, playwright) — deps that must be installed
 * INSIDE the container image (via `external: [...]`) but never pulled into the
 * worker/DO bundle.
 */
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { MyContainer } from "../MyContainer.ts";

export default MyContainer.make(
  Effect.gen(function* () {
    let counter = 0;

    return MyContainer.of({
      hello: () => Effect.succeed(`Hello from container (counter=${counter})`),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/health") {
          return HttpServerResponse.jsonUnsafe({ status: "ok" });
        }
        if (url.pathname === "/increment") {
          counter++;
          return HttpServerResponse.jsonUnsafe({ counter });
        }
        return HttpServerResponse.text("Hello from paired-DO container!");
      }),
    });
  }),
);
