import * as Effect from "effect/Effect";

import { Cloudflare, Stack } from "alchemy-effect";

import { Api, ApiLive } from "./src/Api.ts";

const stack = Effect.gen(function* () {
  const api = yield* Api;

  return {
    url: api.url,
  };
}).pipe(
  // Effect.provide(Layer.provideMerge(ApiLive, SandboxLive))
  Effect.provide(ApiLive),
);

export default stack.pipe(
  Stack.make("CloudflareWorker", Cloudflare.providers()),
);
