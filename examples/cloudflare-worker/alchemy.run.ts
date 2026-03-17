import { Cloudflare, Stack } from "alchemy-effect";
import * as Effect from "effect/Effect";

import Worker from "./src/Worker.ts";

export default Effect.all([
  Worker,
  // other workers go here
]).pipe(Stack.make("CloudflareWorker", Cloudflare.providers()));
