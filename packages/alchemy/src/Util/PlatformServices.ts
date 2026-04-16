import type { BunServices } from "@effect/platform-bun/BunServices";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const isBun = typeof Bun !== "undefined";

export const PlatformServices: Layer.Layer<
  NodeServices | BunServices,
  never,
  never
> = Effect.promise(() => {
  if (isBun) {
    return import("@effect/platform-bun").then(
      (platform) => platform.BunServices.layer,
    );
  }
  return import("@effect/platform-node").then(
    (platform) => platform.NodeServices.layer,
  );
}).pipe(Layer.unwrap);
