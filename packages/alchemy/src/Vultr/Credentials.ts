import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const DEFAULT_BASE_URL = "https://api.vultr.com/v2";

export interface VultrCredentials {
  readonly apiKey: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

export class Credentials extends Context.Service<
  Credentials,
  VultrCredentials
>()("alchemy/Vultr/Credentials") {}

/**
 * Build a `Credentials` layer that reads the Vultr API key from the
 * `VULTR_API_KEY` environment variable. The base URL is fixed to the
 * public Vultr v2 API but can be overridden via `VULTR_API_BASE_URL`.
 */
export const fromEnv = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("VULTR_API_KEY");
      const apiBaseUrl = yield* Config.string("VULTR_API_BASE_URL").pipe(
        Config.withDefault(DEFAULT_BASE_URL),
      );
      return { apiKey, apiBaseUrl };
    }),
  );
