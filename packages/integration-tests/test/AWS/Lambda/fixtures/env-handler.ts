import * as Lambda from "@alchemy.run/aws/Lambda";
import { Random } from "alchemy/Random";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import path from "pathe";
import { bindEnvOutputs, echoEnv, envValues } from "../../../EnvValues.ts";
import { jsonStrings, type JsonStringKey } from "../../../JsonStrings.ts";

const main = path.resolve(import.meta.dirname, "env-handler.ts");

// `Config.String` for every entry in `jsonStrings`.
const readJsonStrings = <A>(map: (config: Config.Config<string>) => Config.Config<A>) =>
  Object.fromEntries(
    Object.keys(jsonStrings).map((key) => [key, map(Config.String(key))]),
  ) as Record<JsonStringKey, Config.Config<A>>;

/**
 * Lambda whose `env` holds strings `JSON.parse` would reinterpret. It echoes
 * them read through `Config` during Init and at request time, and straight
 * from `process.env`, so the test can assert each one arrives unchanged.
 * `values` echoes every {@link envValues} case (non-strings and `Redacted`),
 * and `bound` two values bound in Init, one of them `Redacted`.
 */
export class EnvStringsFunction extends Lambda.Function<EnvStringsFunction>()(
  "EnvStringsFunction",
) {}

export const EnvStringsFunctionLive = EnvStringsFunction.make(
  { main, functionUrl: true, env: { ...jsonStrings, ...envValues } },
  Effect.gen(function* () {
    const random = yield* Random("EnvBoundRandom", { bytes: 4 });
    const bound = yield* bindEnvOutputs(random.text);
    // Optional so plan passes: these are bound from `env`, not from the
    // deploy-time ConfigProvider.
    const init = yield* Config.all({
      ...readJsonStrings((config) => config.pipe(Config.option)),
      JSON_FALSE_BOOL: Config.Boolean("JSON_FALSE").pipe(Config.option),
      JSON_NUM_NUMBER: Config.Number("JSON_NUM").pipe(Config.option),
    });

    return {
      fetch: Effect.gen(function* () {
        const runtime = yield* Config.all({
          ...readJsonStrings((config) => config),
          JSON_FALSE_BOOL: Config.Boolean("JSON_FALSE"),
          JSON_NUM_NUMBER: Config.Number("JSON_NUM"),
        });
        const env = yield* Effect.sync(() =>
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
          Object.fromEntries(Object.keys(jsonStrings).map((key) => [key, process.env[key]])),
        );
        return yield* HttpServerResponse.json({
          init: Object.fromEntries(
            Object.entries(init).map(([k, v]: [string, Option.Option<unknown>]) => [
              k,
              Option.getOrNull(v),
            ]),
          ),
          runtime,
          env,
          values: yield* echoEnv,
          bound: yield* bound,
        });
      }).pipe(Effect.orDie),
    };
  }),
);

export default EnvStringsFunctionLive;
