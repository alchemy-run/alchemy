import { CredentialsStoreLive } from "@/Auth/Credentials";
import { ProfileStoreLive } from "@/Auth/Profile";
import * as DigitalOcean from "@/DigitalOcean";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasDigitalOceanToken = !!(
  process.env.DIGITALOCEAN_TOKEN || process.env.DIGITALOCEAN_ACCESS_TOKEN
);

/** Live tests need a token and are skipped by `--fast`. */
export const skipLive = !hasDigitalOceanToken || !!process.env.FAST;

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

/** True when an out-of-band read answers that the resource does not exist. */
export const isGone = <A, E, R>(
  read: Effect.Effect<A, E | { readonly _tag: "NotFound" }, R>,
) =>
  read.pipe(
    Effect.as(false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    outOfBand,
  );
