import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Remote container (`image` variant): Alchemy pulls the pre-built public
 * image and re-pushes it to Cloudflare's registry — no build, no `main`
 * bundling.
 *
 * Uses `mendhak/http-https-echo`, a tiny Node request-echo server that listens
 * on port 8080 and logs to its stdout file descriptor. Stock nginx images
 * cannot be used as-is here: nginx symlinks its log files to /dev/stdout and
 * /dev/stderr, and opening those device paths fails with ENXIO inside
 * Cloudflare's container sandbox, so nginx crash-loops before binding the port.
 * We can patch that in the `external` variant (we own that Dockerfile) but not
 * in a pulled-as-is public image, so the remote variant uses an image whose
 * server writes to the inherited stdout fd directly.
 *
 * `.make()` only registers the container's identity so it can be bound to a
 * Durable Object.
 */
export class RemoteContainer extends Cloudflare.Container<RemoteContainer>()(
  "RemoteContainer",
  {
    image: "mendhak/http-https-echo:latest",
    observability: { logs: { enabled: true } },
  },
) {}

export default RemoteContainer.make(Effect.succeed(undefined));
