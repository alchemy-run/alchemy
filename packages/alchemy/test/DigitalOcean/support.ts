import { CredentialsStoreLive } from "@/Auth/Credentials";
import { ProfileStoreLive } from "@/Auth/Profile";
import * as DigitalOcean from "@/DigitalOcean";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasDigitalOceanToken = !!(
  process.env.DIGITALOCEAN_TOKEN || process.env.DIGITALOCEAN_ACCESS_TOKEN
);

const isTestingProfile = process.env.ALCHEMY_PROFILE === "testing";

/**
 * Live tests run when a token is set or when the `testing` profile is
 * active. The `testing` profile can hold stored credentials. They also skip
 * under `FAST=1`.
 */
export const skipLive =
  (!hasDigitalOceanToken && !isTestingProfile) || !!process.env.FAST;

/** Credentials resolved the same way the provider resolves them. */
const credentials = DigitalOcean.fromAuthProvider().pipe(
  Layer.provide(DigitalOcean.DigitalOceanAuth),
  Layer.provide(ProfileStoreLive),
  Layer.provide(CredentialsStoreLive),
  Layer.provide(NodeServices.layer),
  Layer.orDie,
);

/**
 * Out-of-band verification context: raw distilled calls, independent of
 * the provider layer under test.
 */
export const outOfBand = Effect.provide(
  Layer.mergeAll(credentials, FetchHttpClient.layer),
);
