import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
export default class ImagesTextWorker extends Cloudflare.Worker<ImagesTextWorker>()(
  "ImagesTextWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const images = yield* Cloudflare.Images.Images("IMAGES");
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const font = new URL(request.url, "http://localhost").searchParams.get(
          "font",
        )!;
        const text = yield* images.text("Alchemy", {
          font: { url: font },
          size: 20,
          color: "lime",
        });
        const result = yield* text
          .output({ format: "rgba" })
          .pipe(Effect.orDie);
        return HttpServerResponse.fromWeb(
          (yield* result.response) as unknown as Response,
        );
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Images.ImagesBinding)),
) {}
