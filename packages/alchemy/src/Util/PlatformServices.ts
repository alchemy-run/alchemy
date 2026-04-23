import type { BunServices } from "@effect/platform-bun/BunServices";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Teardown } from "effect/Runtime";

const isBun = typeof Bun !== "undefined";

export const PlatformServices: Layer.Layer<
  NodeServices | BunServices,
  never,
  never
> = Effect.promise(() => {
  if (isBun) {
    return import("@effect/platform-bun/BunServices").then(
      (BunServices) => BunServices.layer,
    );
  }
  return import("@effect/platform-node/NodeServices").then(
    (NodeServices) => NodeServices.layer,
  );
}).pipe(Layer.unwrap);

export const runMain = <E, A>(
  effect: Effect.Effect<A, E>,
  options?: {
    readonly disableErrorReporting?: boolean | undefined;
    readonly teardown?: Teardown | undefined;
  },
): void => {
  if (isBun) {
    void import("@effect/platform-bun/BunRuntime").then((BunRuntime) =>
      BunRuntime.runMain(effect, options),
    );
  } else {
    void import("@effect/platform-node/NodeRuntime").then((NodeRuntime) =>
      NodeRuntime.runMain(effect, options),
    );
  }
};
