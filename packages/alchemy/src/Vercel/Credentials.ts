import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { VercelMissingCredentials } from "./Errors.ts";

/**
 * Credentials for the Vercel REST API.
 *
 * Token resolution order: explicit `token` prop, then the `VERCEL_TOKEN`
 * environment variable. Team-owned domains also need `teamId` (or
 * `teamSlug`); `VERCEL_TEAM_ID` / `VERCEL_TEAM_SLUG` fill the gap.
 */
export interface VercelCredentials {
  readonly token: string;
  readonly teamId?: string;
  readonly teamSlug?: string;
}

export class Credentials extends Context.Service<
  Credentials,
  VercelCredentials
>()("Vercel.Credentials") {}

const readEnv = (name: string): string | undefined => {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
};

/** Resolve credentials from the environment. Fails when no token is set. */
export const CredentialsFromEnv: Layer.Layer<
  Credentials,
  VercelMissingCredentials
> = Layer.effect(
  Credentials,
  Effect.gen(function* () {
    const token = readEnv("VERCEL_TOKEN");
    if (token === undefined) {
      return yield* new VercelMissingCredentials({
        message:
          "Vercel API token is missing: set VERCEL_TOKEN (or provide credentials explicitly)",
      });
    }
    return {
      token,
      teamId: readEnv("VERCEL_TEAM_ID"),
      teamSlug: readEnv("VERCEL_TEAM_SLUG"),
    } satisfies VercelCredentials;
  }),
);
