/**
 * Report a container's shutdown to the Durable Object that owns it, so it can
 * snapshot the container's filesystem first (see
 * Cloudflare/Containers/Harness.ts). The platform sends `SIGTERM` and waits up
 * to 15 minutes before `SIGKILL`; the process exits once the Durable Object
 * answers.
 */
import * as Effect from "effect/Effect";

/** Set on containers whose Durable Object snapshots them on shutdown. */
export const SNAPSHOT_ON_SHUTDOWN = "ALCHEMY_SNAPSHOT_ON_SHUTDOWN";

/** Intercepted by the Durable Object's harness-control egress. */
const SHUTDOWN_URL = "http://alchemy.internal/shutdown";

/** Leave room under the platform's 15-minute grace period. */
const SHUTDOWN_TIMEOUT_MS = 14 * 60_000;

export const reportShutdown: Effect.Effect<void> = Effect.sync(() => {
  if (!process.env[SNAPSHOT_ON_SHUTDOWN]) return;
  process.once("SIGTERM", () => {
    console.log("[alchemy] SIGTERM: asking the Durable Object to snapshot this container");
    fetch(SHUTDOWN_URL, { method: "POST", signal: AbortSignal.timeout(SHUTDOWN_TIMEOUT_MS) })
      .then(
        (response) => console.log(`[alchemy] snapshot before shutdown: ${response.status}`),
        (error) => console.error("[alchemy] snapshot before shutdown failed:", error),
      )
      .finally(() => process.exit(0));
  });
});
