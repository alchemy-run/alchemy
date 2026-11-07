import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";

export const ServicesEnv = Modal.Environment("ServicesEnv", {});

export const Services = Effect.gen(function* () {
  const environment = yield* ServicesEnv;
  return yield* Modal.App("ServicesApp", { environment });
});
