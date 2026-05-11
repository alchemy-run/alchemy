import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const DNS_BASE_URL = "https://dns.hetzner.com/api/v1";

export interface HetznerDnsCredentialsService {
  readonly token: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

export class HetznerDnsCredentials extends Context.Service<
  HetznerDnsCredentials,
  HetznerDnsCredentialsService
>()("Hetzner::DNS::Credentials") {}

/**
 * Build a `HetznerDnsCredentials` layer from a literal token. Useful for
 * tests or when callers already have a token in hand.
 */
export const fromToken = (
  token: string | Redacted.Redacted<string>,
  apiBaseUrl = DNS_BASE_URL,
) =>
  Layer.succeed(HetznerDnsCredentials, {
    token: typeof token === "string" ? Redacted.make(token) : token,
    apiBaseUrl,
  });

/**
 * Build a `HetznerDnsCredentials` layer that reads the API token from
 * `HETZNER_DNS_API_TOKEN` at layer build time.
 */
export const fromEnv = (apiBaseUrl = DNS_BASE_URL) =>
  Layer.effect(
    HetznerDnsCredentials,
    Effect.gen(function* () {
      const token = yield* Config.redacted("HETZNER_DNS_API_TOKEN");
      return { token, apiBaseUrl };
    }),
  );
