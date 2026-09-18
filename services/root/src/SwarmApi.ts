import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { handleBurst } from "./engineering/Burst.ts";
import type { InboundEvent } from "./engineering/Swarm.ts";
import { swarmDeps } from "./engineering/SwarmLive.ts";

/**
 * The SWARM's side door — drive a walker with synthetic events.
 *
 * Production bursts arrive through the triage batcher (webhooks /
 * the dev poller); this route exists for demos and live smokes,
 * where "three issues just landed" must be conjurable on demand:
 *
 *   POST /api/swarm/burst
 *   { "channel": "engineering",
 *     "events": [{ "repo", "number", "title", "kind" }, …] }
 */
export const SwarmApi = Effect.gen(function* () {
  const deps = yield* swarmDeps;

  return HttpRouter.add(
    "POST",
    "/api/swarm/burst",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const body = (yield* request.json.pipe(Effect.orDie)) as {
        readonly channel?: string;
        readonly events?: ReadonlyArray<InboundEvent>;
      };
      const channel = body.channel ?? "engineering";
      const events = body.events ?? [];
      if (events.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "no events" },
          { status: 400 },
        );
      }
      const report = yield* handleBurst(deps(channel), channel, events).pipe(
        Effect.orDie,
      );
      return yield* HttpServerResponse.json(report);
    }),
  );
});

export type SwarmRoutes = Layer.Layer<never>;
