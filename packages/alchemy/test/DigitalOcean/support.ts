import * as DigitalOcean from "@/DigitalOcean";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/** Live suites are skipIf-gated on a token in the environment. */
export const hasDigitalOceanCreds = !!(
  process.env.DIGITALOCEAN_TOKEN || process.env.DIGITALOCEAN_ACCESS_TOKEN
);

/**
 * Out-of-band verification context: raw distilled calls with env
 * credentials, independent of the provider layer under test.
 */
export const outOfBand = Effect.provide(
  Layer.mergeAll(DigitalOcean.CredentialsFromEnv, FetchHttpClient.layer),
);
