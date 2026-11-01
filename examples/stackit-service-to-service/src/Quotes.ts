import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { Puller, registryFor } from "./registry.ts";

/**
 * The backend, in the async form, with its handler in `quotes-handler.ts`.
 *
 * The gateway binds to this resource, so this module also runs inside the deployed
 * gateway, where the path means nothing and `import.meta.url` may not be a URL.
 */
export const Quotes = Effect.gen(function* () {
  const puller = yield* Puller;
  const registry = yield* registryFor("quotes");
  return yield* Stackit.Functions.Function("Quotes", {
    main: globalThis.__ALCHEMY_RUNTIME__
      ? "quotes-handler.ts"
      : new URL("./quotes-handler.ts", import.meta.url).href,
    registry,
    pullCredential: puller.pullCredentialId,
  });
});
