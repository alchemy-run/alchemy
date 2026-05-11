import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const CLOUD_BASE_URL = "https://api.hetzner.cloud/v1";

export interface HetznerCredentialsService {
  readonly token: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

export class HetznerCredentials extends Context.Service<
  HetznerCredentials,
  HetznerCredentialsService
>()("Hetzner::Cloud::Credentials") {}

/**
 * Build a `HetznerCredentials` layer from a literal token. Useful for
 * tests or when callers already have a token in hand.
 */
export const fromToken = (
  token: string | Redacted.Redacted<string>,
  apiBaseUrl = CLOUD_BASE_URL,
) =>
  Layer.succeed(HetznerCredentials, {
    token: typeof token === "string" ? Redacted.make(token) : token,
    apiBaseUrl,
  });

/**
 * Build a `HetznerCredentials` layer that reads the API token from
 * `HCLOUD_TOKEN` at layer build time.
 */
export const fromEnv = (apiBaseUrl = CLOUD_BASE_URL) =>
  Layer.effect(
    HetznerCredentials,
    Effect.gen(function* () {
      const token = yield* Config.redacted("HCLOUD_TOKEN");
      return { token, apiBaseUrl };
    }),
  );
