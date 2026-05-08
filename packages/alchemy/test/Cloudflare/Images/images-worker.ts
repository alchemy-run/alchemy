import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Standalone Images binding the worker attaches via the Effect-style
 * init phase. `name` becomes the runtime binding key.
 */
export const Pipeline = Cloudflare.Images({ name: "PIPELINE" });

export default class ImagesWorker extends Cloudflare.Worker<ImagesWorker>()(
  "ImagesEffectWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const pipeline = yield* Pipeline;
    const images = yield* Cloudflare.Images.bind(pipeline);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const info = yield* images.info(request.stream).pipe(Effect.orDie);
        return yield* HttpServerResponse.json(info);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.ImagesBindingLive)),
) {}
