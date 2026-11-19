import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { envValues, readEnvValues } from "../../../EnvValues.ts";
import { TestRegistry } from "./shared.ts";

/**
 * Effect-native App deployed with every {@link envValues} case; `fetch`
 * echoes the raw `process.env` value of each. Deployed from
 * {@link ../../Env.test.ts}.
 */
export default class EnvApp extends DigitalOcean.App<EnvApp>()(
  "EnvApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc", env: envValues },
  Effect.succeed({
    fetch: Effect.gen(function* () {
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
      const env = yield* Effect.sync(() => readEnvValues(process.env));
      return yield* HttpServerResponse.json(env);
    }),
  }),
) {}
