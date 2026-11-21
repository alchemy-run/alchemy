import type * as Fly from "@alchemy.run/fly";
import * as Output from "alchemy/Output";

/** The Machine metadata key that carries the digests of the App secrets it reads. */
export const SECRETS_DIGEST_KEY = "rivet.secrets-digest";

/**
 * Machine metadata naming the digests of App secrets a Machine reads as
 * env. Fly never says which secrets a Machine uses, so this is what makes
 * the Machine wait for them and restart when one changes.
 *
 * @internal
 */
export const secretsDigest = (secrets: readonly Fly.Secret[]) =>
  Output.all(...secrets.map((secret) => secret.digest)).pipe(
    Output.map((digests) => ({ [SECRETS_DIGEST_KEY]: digests.map((d) => d ?? "").join(",") })),
  );
