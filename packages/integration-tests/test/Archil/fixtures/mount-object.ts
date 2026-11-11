import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MountContainer } from "./mount-container.ts";

/** Starts the mount Container and reads a file through its mount. */
export class MountObject extends Cloudflare.DurableObject<MountObject>()(
  "ArchilMountObject",
  Effect.gen(function* () {
    const container = yield* MountContainer;
    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(3000);
      return {
        read: (key: string) =>
          Effect.gen(function* () {
            // The Archil client needs outbound networking to reach Archil.
            yield* container.start({ enableInternet: true });
            const response = yield* fetch(
              HttpClientRequest.get(`http://container/?key=${encodeURIComponent(key)}`),
            );
            return { status: response.status, body: yield* response.text };
          }),
      };
    });
  }),
) {}
