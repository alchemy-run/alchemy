import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { TestRegistry } from "./shared.ts";

export default class EffectApp extends DigitalOcean.App<EffectApp>()(
  "EffectApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc" },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({ runtime: "effect", ok: true });
      }),
    };
  }),
) {}
