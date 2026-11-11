import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { IGNORED_WRITES_PORT, IgnoredWritesContainer } from "./container.ts";

/** Durable Object fronting {@link IgnoredWritesContainer}; proxies `path` into it. */
export class IgnoredWritesObject extends Cloudflare.DurableObject<IgnoredWritesObject>()(
  "IgnoredWritesObject",
  Effect.gen(function* () {
    const container = yield* IgnoredWritesContainer;

    return Effect.gen(function* () {
      const start = container.start({ enableInternet: false });
      const { fetch } = yield* container.getTcpPort(IGNORED_WRITES_PORT);

      return {
        read: (path: string) =>
          Effect.gen(function* () {
            yield* start;
            const response = yield* fetch(HttpClientRequest.get(`http://container${path}`));
            return yield* response.text;
          }),
      };
    });
  }),
) {}
