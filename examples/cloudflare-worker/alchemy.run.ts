import { Cloudflare, Stack } from "alchemy-effect";
import * as Output from "alchemy-effect/Output";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";

const stack = Effect.gen(function* () {
  const api = yield* Api;
  // const sandbox = yield* Sandbox;

  return {
    url: Output.interpolate`${api.url}/profile/sam`,
    time: new Date().toISOString(),
    // applicationId: sandbox.applicationId,
  };
});

export default stack.pipe(
  Stack.make("CloudflareWorker", Cloudflare.providers()),
);
