import { Cloudflare, Stack } from "alchemy-effect";
import * as Effect from "effect/Effect";

import Simple from "./src/Api.ts";

const stack = Effect.gen(function* () {
  const api = yield* Simple;
  // const sandbox = yield* Sandbox;

  return api.url;
});

export default stack.pipe(
  Stack.make("CloudflareScratchpad", Cloudflare.providers()),
);
