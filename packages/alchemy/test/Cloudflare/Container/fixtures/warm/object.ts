import * as Cloudflare from "@/Cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { WarmContainer } from "./container.ts";

/**
 * How often the `keepWarm` schedule re-checks the container. Deliberately far
 * longer than a poll round-trip so a test can still observe the container
 * *down* right after killing it (a sub-second cadence would race the probe),
 * yet short enough that the restart lands well inside the test timeout.
 */
const KEEP_WARM_INTERVAL = Duration.seconds(15);

/**
 * Durable Object backing one {@link WarmContainer}, exposing the levers the
 * warm tests need:
 *  - `ping` / `boot` — RPC into the container (also forces a start)
 *  - `running`       — the raw `container.running` flag, which reading never
 *                      itself restarts the container (so a `false → true`
 *                      transition with no other traffic is attributable to
 *                      `keepWarm` alone)
 *  - `stop`          — hard stop from the DO side (`destroy` = SIGKILL)
 *  - `warmed`        — what this DO observed when something woke it via its
 *                      `fetch` handler, which is how `warmPool` reaches it
 *
 * The `fetch` handler records the wake in durable storage rather than in a
 * closure variable, so the assertion survives the DO being evicted between
 * the warm pass and the probe.
 */
export class WarmObject extends Cloudflare.DurableObject<WarmObject>()(
  "WarmObject",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const container = yield* WarmContainer;

    return Effect.gen(function* () {
      return {
        ping: () => container.ping(),
        boot: () => container.boot(),
        running: () => container.running,
        stop: () => container.destroy(),
        warmed: () =>
          Effect.gen(function* () {
            const count = (yield* state.storage.get<number>("warmed")) ?? 0;
            const runningAtWarm =
              (yield* state.storage.get<boolean>("runningAtWarm")) ?? false;
            return { count, runningAtWarm };
          }),
        // Any inbound call constructs the DO if it isn't resident, which is
        // where the container layer's eager start fires — this is exactly the
        // path `warmPool` drives. Record that the wake arrived, and whether
        // the container was up by the time it did.
        fetch: Effect.gen(function* () {
          const count = (yield* state.storage.get<number>("warmed")) ?? 0;
          yield* state.storage.put("warmed", count + 1);
          yield* state.storage.put("runningAtWarm", yield* container.running);
          return HttpServerResponse.text("warmed");
        }),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(WarmContainer, {
        enableInternet: true,
        keepWarm: Schedule.spaced(KEEP_WARM_INTERVAL),
      }),
    ),
  ),
) {}
