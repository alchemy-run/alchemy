import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class CycleContainer extends Cloudflare.Container<CycleContainer>()(
  "CycleContainer",
  {
    image: `registry.cloudflare.com/11111111111111111111111111111111/fixture@sha256:${"a".repeat(64)}`,
    className: "IgnoredByEffectNativeHost",
  },
) {}

export class CycleObject extends Cloudflare.DurableObject<CycleObject>()(
  "ActualHostedClass",
  Effect.gen(function* () {
    yield* CycleContainer;
    return Effect.succeed({ ping: () => Effect.succeed("pong") });
  }).pipe(Effect.provide(Cloudflare.Containers.layer(CycleContainer))),
) {}

export const CycleWorker = Cloudflare.Worker(
  "CycleWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* CycleObject;
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }),
);
