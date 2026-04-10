import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";

const stack = Effect.gen(function* () {
  const worker = yield* Cloudflare.Vite("Website");

  return {
    url: worker.url,
  };
}).pipe(Stack.make("CloudflareVite", Cloudflare.providers()));

export default stack;
