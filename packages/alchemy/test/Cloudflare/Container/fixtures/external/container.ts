import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * External container (`context` / `dockerfile` variant): Alchemy builds the
 * user-supplied Dockerfile against the build context directory — no `main`
 * bundling. The `dockerfile` defaults to `<context>/Dockerfile`.
 *
 * The image is the non-root `nginx-unprivileged` base serving a static page on
 * port 8080 (stock nginx on port 80 exits with code 1 inside Cloudflare's
 * container sandbox), so there is no Effect runtime; `.make()` only registers
 * the container's identity so it can be bound to a Durable Object.
 */
const context = `${import.meta.dirname}/context`;

export class ExternalContainer extends Cloudflare.Container<ExternalContainer>()(
  "ExternalContainer",
  { context, observability: { logs: { enabled: true } } },
) {}

export default ExternalContainer.make(Effect.succeed(undefined));
