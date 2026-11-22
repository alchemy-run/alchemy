import {
  controlPlaneUrl,
  Credentials,
  DEFAULT_REGION,
  REGIONS,
} from "@distilled.cloud/archil/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ARCHIL_AUTH_PROVIDER_NAME, type ArchilResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_REGION,
  REGIONS,
} from "@distilled.cloud/archil/Credentials";

/** Where the current Archil credentials act. */
export interface ArchilAccount {
  /** Archil region id, e.g. `aws-us-east-1`. */
  readonly region: string;
  /** Archil organization id, when configured. */
  readonly organization: string | undefined;
}

/**
 * The region (and organization) the current Archil credentials act in.
 * Holds an effect so it resolves on first use, never at layer build.
 */
export class Account extends Context.Service<Account, Effect.Effect<ArchilAccount>>()(
  "Archil.Account",
) {}

/** The region and organization of the current Archil credentials. */
export const account = Effect.gen(function* () {
  return yield* yield* Account;
});

const make = (
  resolve: Effect.Effect<ArchilResolvedCredentials, ConfigError>,
): Effect.Effect<Context.Context<Credentials | Account>> =>
  Effect.gen(function* () {
    const credentials = Effect.flatMap(resolve, (creds) => {
      const apiBaseUrl = controlPlaneUrl(creds.region);
      return apiBaseUrl
        ? Effect.succeed({ apiKey: creds.apiKey, apiBaseUrl, region: creds.region })
        : Effect.fail(
            new ConfigError({
              message: `Unknown Archil region "${creds.region}". Valid regions: ${Object.keys(REGIONS).join(", ")}`,
            }),
          );
    });
    // `Account` is typed as never failing, so a credentials failure dies
    // here; the engine still reports it as `CredentialsRequired`.
    const accountInfo = yield* resolve.pipe(
      Effect.map((creds) => ({ region: creds.region, organization: creds.organization })),
      Effect.orDie,
      Effect.cached,
    );
    return Context.make(Credentials, credentials).pipe(Context.add(Account, accountInfo));
  });

/**
 * Build Archil `Credentials` + `Account` from an explicit API key. Useful
 * for tests, or for a runtime that reads its key from a binding.
 *
 * @example
 * ```ts
 * Effect.provide(Archil.fromApiKey({ apiKey: "key-...", region: "aws-us-east-1" }))
 * ```
 */
export const fromApiKey = (input: {
  apiKey: string | Redacted.Redacted<string>;
  region?: string;
  organization?: string;
}) =>
  Effect.succeed<ArchilResolvedCredentials>({
    type: "apiKey",
    apiKey: typeof input.apiKey === "string" ? Redacted.make(input.apiKey) : input.apiKey,
    region: input.region ?? DEFAULT_REGION,
    organization: input.organization,
    source: { type: "stored" },
  }).pipe(make, Layer.effectContext);

/**
 * Build Archil `Credentials` + `Account` that resolve through the Alchemy
 * AuthProvider: environment credentials (`ARCHIL_API_KEY`) when present,
 * otherwise the selected profile. Resolution is deferred until the first
 * API call, so building the provider layers never needs a profile.
 */
export const fromAuthProvider = () =>
  Layer.effectContext(
    lazyCredentials<ArchilResolvedCredentials, ConfigError>()(
      ARCHIL_AUTH_PROVIDER_NAME,
      (creds) => creds,
    ).pipe(Effect.flatMap(make)),
  );
