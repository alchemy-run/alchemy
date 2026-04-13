import { Cloudflare, Stack } from "alchemy-effect";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";

const stack = Effect.gen(function* () {
  const api = yield* Api;
  return api.url;
});

export default stack.pipe(Stack.make("PrPackage", Cloudflare.providers()));
