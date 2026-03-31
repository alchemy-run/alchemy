import { Cloudflare, Stack } from "alchemy-effect";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { Sandbox, SandboxLive } from "./src/Sandbox.ts";

const stack = Effect.gen(function* () {
  const api = yield* Api;
  const sandbox = yield* Sandbox;

  return {
    url: api.url,
    applicationId: sandbox.applicationId,
  };
}).pipe(Effect.provide(SandboxLive));

export default stack.pipe(
  Stack.make("CloudflareWorker", Cloudflare.providers()),
);
