import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Cloudflare, Stack } from "alchemy-effect";

import { Api, ApiLive } from "./src/Api.ts";
import { SandboxLive } from "./src/Sandbox.ts";

const stack = Effect.gen(function* () {
  const api = yield* Api;

  return {
    url: api.url,
  };
}).pipe(
  Effect.provide(Layer.provideMerge(ApiLive, SandboxLive)),
  Stack.make("CloudflareWorker", Cloudflare.providers()),
);

export default stack;
