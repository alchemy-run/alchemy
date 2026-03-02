import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Endpoint } from "./Server/Endpoint.ts";

export const make = <E extends Endpoint>(endpoint: E) =>
  Layer.effect(
    endpoint,
    Effect.gen(function* () {
      return {
        // TODO
      };
    }),
  );
