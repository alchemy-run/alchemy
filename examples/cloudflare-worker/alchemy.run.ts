import { Cloudflare, Stack } from "alchemy-effect";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";

export default Effect.all([
  Api,
  // other workers go here
]).pipe(Stack.make("CloudflareWorker", Cloudflare.providers()));
