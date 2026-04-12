import { Cloudflare, Stack } from "alchemy-effect";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";

export default Effect.gen(function* () {
  const api = yield* Api;

  return api.url.as<string>();
}).pipe(Stack.make("CloudflareWorker", Cloudflare.providers()));
