import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Fns = DigitalOcean.Functions.Namespace("RuntimeFns", { region: "nyc1" });

/** Answers with the `GREETING` Config value bound at deploy, the request's method and path, and its body. */
export default class EffectFunction extends DigitalOcean.Functions.Function<EffectFunction>()(
  "EffectFunction",
  { main: import.meta.url, namespace: Fns },
  Effect.gen(function* () {
    const greeting = yield* Config.String("GREETING");
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const body = request.method === "POST" ? yield* request.text : "";
        return yield* HttpServerResponse.json({
          greeting,
          method: request.method,
          path: new URL(request.url, "http://x").pathname,
          body,
        });
      }).pipe(Effect.orDie),
    };
  }),
) {}
