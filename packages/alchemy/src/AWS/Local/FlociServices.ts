/** @effect-diagnostics anyUnknownInErrorContext:off */

import * as Floci from "@alchemy.run/floci";
import type { FlociError } from "@alchemy.run/floci";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import type { Platform } from "../../Platform.ts";
import type { ResourceClassLike, ResourceLike } from "../../Resource.ts";
import { DEFAULT_LOCAL_ENDPOINT, LOCAL_ACCOUNT_ID } from "../AuthProvider.ts";
import * as Endpoint from "../Endpoint.ts";
import { AWSEnvironment } from "../Environment.ts";
import * as Region from "../Region.ts";
import { provideProviderContext } from "./ProviderContext.ts";

/**
 * Fixed dummy account used for every floci-emulated resource. Attributes
 * computed from it (ARNs, queue URLs) double as proof that no real AWS
 * account was involved.
 */
export const FLOCI_ACCOUNT_ID = LOCAL_ACCOUNT_ID;

/** Region every floci-emulated resource lives in. */
export const FLOCI_REGION = "us-east-1";

/**
 * The provider-owned identity and endpoint for one local Floci context.
 *
 * This is deliberately separate from process environment variables: callers
 * can build multiple {@link flociServices} layers in one process without one
 * local account changing another one's credentials or endpoint. `floci` is a
 * constrained pass-through for emulator lifecycle settings; it does not carry
 * product-specific constants.
 */
export interface FlociProfile {
  /** Gateway URL used by all AWS SDK operations in this context. */
  readonly endpoint?: string;
  /** Region used for signing and generated resource attributes. */
  readonly region?: string;
  /** Account used for generated resource attributes. */
  readonly accountId?: string;
  /** Credentials used to sign calls to the emulator. */
  readonly credentials?: {
    readonly accessKeyId?: string | Redacted.Redacted<string>;
    readonly secretAccessKey?: string | Redacted.Redacted<string>;
    readonly sessionToken?: string | Redacted.Redacted<string>;
  };
  /** Optional Floci lifecycle settings owned by the provider integration. */
  readonly floci?: Pick<
    Floci.FlociConfig,
    | "image"
    | "port"
    | "containerName"
    | "storageDir"
    | "dockerSocket"
    | "env"
    | "elbListenerPorts"
    | "cloudfrontEdgePorts"
    | "readinessTimeout"
  >;
  /** Whether to start Floci when the configured endpoint is not serving. */
  readonly autoStart?: boolean;
}

/** JSON-safe profile shape sent to an RPC sidecar for one provider context. */
export interface FlociProfileTransport extends Omit<
  FlociProfile,
  "credentials"
> {
  readonly credentials?: {
    readonly accessKeyId?: string;
    readonly secretAccessKey?: string;
    readonly sessionToken?: string;
  };
}

/** Provider context carrying a stack's selected local Floci profile. */
export class FlociProfileService extends Context.Service<
  FlociProfileService,
  FlociProfile
>()("AWS::Local::FlociProfile") {}

const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/** Convert a local profile to the JSON-safe form carried by RPC sessions. */
export const serializeFlociProfile = (
  profile: FlociProfile,
): FlociProfileTransport => ({
  ...profile,
  credentials:
    profile.credentials === undefined
      ? undefined
      : {
          accessKeyId: reveal(profile.credentials.accessKeyId),
          secretAccessKey: reveal(profile.credentials.secretAccessKey),
          sessionToken: reveal(profile.credentials.sessionToken),
        },
});

const DEFAULT_ACCESS_KEY_ID = "test";
const DEFAULT_SECRET_ACCESS_KEY = "test";

const materialize = (
  value: string | Redacted.Redacted<string> | undefined,
  fallback: string,
): Redacted.Redacted<string> =>
  value === undefined
    ? Redacted.make(fallback)
    : Redacted.isRedacted(value)
      ? value
      : Redacted.make(value);

const portOf = (endpoint: string): number => {
  try {
    return (
      Number.parseInt(new URL(endpoint).port, 10) || Floci.DEFAULT_FLOCI_PORT
    );
  } catch {
    return Floci.DEFAULT_FLOCI_PORT;
  }
};

/** Resolve omitted profile fields while retaining the standalone defaults. */
export const resolveFlociProfile = (
  profile: FlociProfile = {},
): {
  readonly endpoint: string;
  readonly region: string;
  readonly accountId: string;
  readonly credentials: {
    readonly accessKeyId: Redacted.Redacted<string>;
    readonly secretAccessKey: Redacted.Redacted<string>;
    readonly sessionToken: Redacted.Redacted<string> | undefined;
  };
  readonly floci: FlociProfile["floci"];
  readonly autoStart: FlociProfile["autoStart"];
} => {
  const endpoint = profile.endpoint ?? DEFAULT_LOCAL_ENDPOINT;
  const region = profile.region ?? FLOCI_REGION;
  const accountId = profile.accountId ?? FLOCI_ACCOUNT_ID;
  const customAccount = accountId !== LOCAL_ACCOUNT_ID;
  return {
    endpoint,
    region,
    accountId,
    credentials: {
      accessKeyId: materialize(
        profile.credentials?.accessKeyId,
        customAccount ? accountId : DEFAULT_ACCESS_KEY_ID,
      ),
      secretAccessKey: materialize(
        profile.credentials?.secretAccessKey,
        DEFAULT_SECRET_ACCESS_KEY,
      ),
      sessionToken:
        profile.credentials?.sessionToken === undefined
          ? undefined
          : materialize(profile.credentials.sessionToken, ""),
    },
    floci: profile.floci,
    autoStart: profile.autoStart,
  };
};

// Annotated (not inferred): the inferred union names distilled's Endpoint
// through a non-portable relative path (TS2883), and consumers only ever
// hand this to `provideProviderContext`, which takes `Layer<any, any, never>`.
const makeFlociServices = (
  input: FlociProfile,
): Layer.Layer<any, FlociError, never> => {
  const profile = resolveFlociProfile(input);
  const region = profile.region as RegionName;
  const resolved = {
    accessKeyId: profile.credentials.accessKeyId,
    secretAccessKey: profile.credentials.secretAccessKey,
    sessionToken: profile.credentials.sessionToken,
    region,
  };
  const credentials = Effect.succeed(resolved);
  const flociConfig = {
    ...profile.floci,
    port: profile.floci?.port ?? portOf(profile.endpoint),
  };
  return Layer.mergeAll(
    // Pin every distilled SDK call made by a wrapped lifecycle method to the
    // emulator gateway with dummy credentials in the emulator's region.
    Endpoint.of(profile.endpoint),
    Region.of(region),
    Layer.succeed(Credentials, credentials),
    // Providers read `AWSEnvironment.current` inside lifecycle operations to
    // compute ARNs/attrs (accountId, region) — override it so computed
    // identities carry the dummy account and the emulator endpoint.
    Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId: profile.accountId,
        region: profile.region,
        credentials,
        endpoint: profile.endpoint,
      }),
    ),
    // Building the services guarantees the emulator is serving: reuses
    // anything already listening on the endpoint, otherwise starts (or
    // revives) the managed `alchemy-floci` container and waits for health.
    Layer.effectDiscard(
      (profile.autoStart ?? profile.endpoint === DEFAULT_LOCAL_ENDPOINT)
        ? Floci.ensureFloci(flociConfig)
        : Effect.void,
    ),
  );
};

/**
 * The floci-scoped override context for local-mode AWS providers, as a
 * provider-owned layer reference (see the note on
 * [Local/ProviderLayer.ts](../../Local/ProviderLayer.ts)). A caller that
 * shares one returned layer reference across registrations gets one Floci
 * lifecycle per stack build; separate profiles produce separate references
 * and cannot leak identity or endpoint state into one another.
 */
export const flociServices = (
  profile?: FlociProfile,
): Layer.Layer<any, FlociError, never> =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (profile !== undefined) return makeFlociServices(profile);
      const selected = yield* Effect.serviceOption(FlociProfileService);
      return makeFlociServices(
        Option.getOrElse(selected, () => ({}) as FlociProfile),
      );
    }),
  ) as Layer.Layer<any, FlociError, never>;

/**
 * Registers an AWS resource provider with both a **live** and a **local**
 * (floci-emulated) implementation via `ProviderLayer.dual`. The local
 * variant is the SAME live provider code with every lifecycle method
 * endpoint-wrapped to the floci emulator ({@link flociServices}), so
 * `alchemy dev` routes the resource to the emulator while `alchemy deploy`
 * (and `Alchemy.remote()` in dev) keeps hitting the real cloud.
 *
 * @example
 * ```ts
 * // in Providers.ts, replacing `S3.BucketProvider(),`:
 * flociDual(S3.Bucket, () => S3.BucketProvider()),
 * ```
 */
export const flociDual = <
  R extends ResourceLike,
  L extends Layer.Layer<any, any, any>,
>(
  cls:
    | ResourceClassLike<R>
    | Platform<R, any, any, any, any>
    | { Type: R["Type"] },
  live: () => L,
) => {
  // Keep one layer reference for both the local lifecycle and its data plane.
  // ProviderLayer's MemoMap then builds the selected profile once per stack,
  // while separate `AWS.providers({ local: ... })` layers retain isolation.
  const services = flociServices();
  return ProviderLayer.dual(cls, {
    live,
    local: () => provideProviderContext(live(), services),
    // Registered as the resource's local data plane so deploy-time binding
    // clients (Action bodies, plan-time `execute`) route their API calls to
    // the emulator whenever the bound resource resolves to local mode.
    dataPlane: () => services,
  });
};
