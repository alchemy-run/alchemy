import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Cloudflare from "@/Cloudflare";
import { MountBox } from "./container.ts";

/** Binds the container and exposes its `/check` route to the Worker. */
export class MountObject extends Cloudflare.DurableObject<MountObject>()(
  "MountObject",
  Effect.gen(function* () {
    const box = yield* MountBox;
    return Effect.gen(function* () {
      const start = box.start({ enableInternet: true });
      const { fetch } = yield* box.getTcpPort(3000);
      return {
        check: () =>
          start.pipe(
            Effect.andThen(fetch(HttpClientRequest.get("http://container/check"))),
            Effect.flatMap((response) => response.text),
          ),
      };
    });
  }),
) {}
