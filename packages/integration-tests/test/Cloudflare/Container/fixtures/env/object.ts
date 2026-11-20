import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { EnvContainer } from "./container.ts";

/** Durable Object that starts {@link EnvContainer} and relays its env echo. */
export class EnvObject extends Cloudflare.DurableObject<EnvObject>()(
  "EnvObject",
  Effect.gen(function* () {
    const container = yield* EnvContainer;
    return Effect.gen(function* () {
      const start = container.start({ enableInternet: true });
      return {
        readEnv: () => start.pipe(Effect.andThen(container.readEnv())),
      };
    });
  }),
) {}
